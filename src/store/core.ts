/**
 * Row-level primitives shared by every domain store.
 *
 * These are the calls that make an item visible to synced clients: the row
 * itself, its ownership in `user_items`, and the sync event in `changes_2`.
 * Nothing in `src/tools` may talk to PostgreSQL directly — a handler receives
 * this store, so a fake one is enough to exercise it without a database.
 */

import type { Pool } from "pg";
import { parseJoplinContent } from "../lib/content.js";
import { generateId, jopTypeToChangeItemType } from "../lib/ids.js";
import { JOP_TYPE_FOLDER, JOP_TYPE_NOTE, type JoplinItemRow } from "../lib/joplin-types.js";

export interface ChangeParams {
  itemId: string;
  /** jop_type from `items` (1 note, 2 folder, 4 resource, 5 tag, 6 note-tag, 0 blob). */
  itemType: number;
  /** CHANGE_CREATED, CHANGE_UPDATED or CHANGE_DELETED. */
  changeType: number;
  jopId: string;
  userId: string;
  /** Sync name; blob rows use `.resource/<jop_id>` instead of `<jop_id>.md`. */
  itemName?: string;
  /** Real clients write 2 on creation and 1 on update. */
  changeItemType?: number;
}

export interface Core {
  /** The Joplin account the server acts for: the pinned one, else the oldest. */
  resolveUserId(): Promise<string>;
  /** Row ownership, without which a synced client never sees the item. */
  recordUserItem(params: { itemId: string; userId: string }): Promise<void>;
  /** Sync event, without which a synced client never learns about the write. */
  recordChange(params: ChangeParams): Promise<void>;
  /** Resolve an item by the MCP-facing base62 id or the client-facing jop_id. */
  findItem(idOrJopId: string, jopType: number, userId: string): Promise<JoplinItemRow | null>;
  /** Notebook titles indexed by jop_id, for the listings that show a notebook name. */
  listFolderTitles(userId: string): Promise<Map<string, string>>;
  /** Title of one notebook, resolved by its jop_id. */
  findFolderTitle(userId: string, folderJopId: string): Promise<string | null>;
  /** Most recently updated notebook jop_id, used as the default parent of a new note. */
  firstFolderJopId(userId: string): Promise<string | null>;
  /** Every note of the account, with the parent column but without the notebook body. */
  listNotes(userId: string): Promise<JoplinItemRow[]>;
  /** Notes resolved by their client-facing jop_id, for the tag listings. */
  listNotesByJopIds(userId: string, jopIds: string[]): Promise<JoplinItemRow[]>;
  /**
   * Rewrite an item body. Blob rows keep jop_updated_time at 0, every other row
   * advances both clocks; returns the timestamp written.
   */
  updateItemContent(params: { id: string; content: Buffer; touchJopUpdatedTime?: boolean }): Promise<number>;
}

export interface CoreBuild {
  /** The API handed to the tool layer: no pool in there. */
  core: Core;
  /** Kept for the sibling stores that still need raw statements. */
  pool: Pool;
}

export function createCore(pool: Pool, pinnedUserId: string): CoreBuild {
  /**
   * Since joplin-server 3.7.1 (migration split_changes) the delta sync reads
   * `changes_2`; the legacy table is kept as a fallback and detected once.
   */
  let activeChangesTable: "changes_2" | "changes" | null = null;

  const activeChanges = async (): Promise<"changes_2" | "changes"> => {
    if (activeChangesTable) {
      return activeChangesTable;
    }
    const result = await pool.query("SELECT to_regclass('public.changes_2') AS tbl");
    activeChangesTable = result.rows[0]?.tbl ? "changes_2" : "changes";
    return activeChangesTable;
  };

  const core: Core = {
    async resolveUserId(): Promise<string> {
      if (pinnedUserId) {
        return pinnedUserId;
      }
      const result = await pool.query("SELECT id FROM users ORDER BY created_time LIMIT 1");
      if (result.rows.length > 0) {
        return result.rows[0].id;
      }
      throw new Error("No user found in Joplin database");
    },

    async recordUserItem(params): Promise<void> {
      const { itemId, userId } = params;
      const now = Date.now();
      const existing = await pool.query("SELECT id FROM user_items WHERE item_id = $1 AND user_id = $2", [itemId, userId]);
      if (existing.rows.length === 0) {
        await pool.query("INSERT INTO user_items (user_id, item_id, updated_time, created_time) VALUES ($1, $2, $3, $3)", [
          userId,
          itemId,
          now,
        ]);
      }
    },

    async recordChange(params): Promise<void> {
      const { itemId, itemType, changeType, jopId, userId } = params;
      const changeId = generateId();
      const now = Date.now();
      const itemName = params.itemName ?? `${jopId}.md`;
      const changesItemType = params.changeItemType ?? jopTypeToChangeItemType(itemType);
      if ((await activeChanges()) === "changes_2") {
        await pool.query(
          `INSERT INTO changes_2 (id, item_id, user_id, item_name, previous_share_id, item_type, type, updated_time, created_time)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [changeId, itemId, userId, itemName, "", changesItemType, changeType, now, now],
        );
      } else {
        await pool.query(
          `INSERT INTO changes (id, item_type, item_id, item_name, type, updated_time, created_time, previous_item, user_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [changeId, changesItemType, itemId, itemName, changeType, now, now, "", userId],
        );
      }
    },

    async findItem(idOrJopId, jopType, userId): Promise<JoplinItemRow | null> {
      const result = await pool.query(
        `SELECT id, name, content, jop_id, jop_parent_id, jop_type, content_size, updated_time
         FROM items WHERE owner_id = $1 AND jop_type = $2 AND (id = $3 OR jop_id = $3) LIMIT 1`,
        [userId, jopType, idOrJopId],
      );
      return (result.rows[0] as JoplinItemRow) || null;
    },

    async listFolderTitles(userId): Promise<Map<string, string>> {
      const result = await pool.query("SELECT jop_id, content FROM items WHERE owner_id = $1 AND jop_type = $2", [userId, JOP_TYPE_FOLDER]);
      const titles = new Map<string, string>();
      for (const row of result.rows) {
        titles.set(String(row.jop_id), parseJoplinContent(row.content).title);
      }
      return titles;
    },

    async findFolderTitle(userId, folderJopId): Promise<string | null> {
      const result = await pool.query("SELECT content FROM items WHERE owner_id = $1 AND jop_id = $2 AND jop_type = $3", [
        userId,
        folderJopId,
        JOP_TYPE_FOLDER,
      ]);
      return result.rows.length > 0 ? parseJoplinContent(result.rows[0].content).title : null;
    },

    async firstFolderJopId(userId): Promise<string | null> {
      const result = await pool.query("SELECT jop_id FROM items WHERE owner_id = $1 AND jop_type = $2 ORDER BY updated_time DESC LIMIT 1", [
        userId,
        JOP_TYPE_FOLDER,
      ]);
      return result.rows.length > 0 ? String(result.rows[0].jop_id) : null;
    },

    async listNotes(userId): Promise<JoplinItemRow[]> {
      const result = await pool.query(
        "SELECT id, content, jop_id, jop_parent_id, updated_time FROM items WHERE owner_id = $1 AND jop_type = $2",
        [userId, JOP_TYPE_NOTE],
      );
      return result.rows;
    },

    async listNotesByJopIds(userId, jopIds): Promise<JoplinItemRow[]> {
      if (jopIds.length === 0) {
        return [];
      }
      const result = await pool.query(
        "SELECT id, content, jop_id, jop_parent_id, updated_time FROM items WHERE owner_id = $1 AND jop_type = $2 AND jop_id = ANY($3::text[])",
        [userId, JOP_TYPE_NOTE, jopIds],
      );
      return result.rows;
    },

    async updateItemContent(params): Promise<number> {
      const now = Date.now();
      await pool.query(
        params.touchJopUpdatedTime === false
          ? "UPDATE items SET content = $1, content_size = $2, updated_time = $3 WHERE id = $4"
          : "UPDATE items SET content = $1, content_size = $2, updated_time = $3, jop_updated_time = $3 WHERE id = $4",
        [params.content, params.content.length, now, params.id],
      );
      return now;
    },
  };

  return { core, pool };
}
