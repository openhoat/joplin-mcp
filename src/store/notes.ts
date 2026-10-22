/**
 * Note store.
 *
 * A note is an ordinary `items` row with jop_type 1; its metadata (title, body,
 * todo fields, deleted_time) lives in the JSON body. Searching, listing and the
 * three write paths are here so the handlers stay free of SQL.
 */

import type { Pool } from "pg";
import { buildNoteContent } from "../lib/content.js";
import { generateId, generateJopId } from "../lib/ids.js";
import { CHANGE_CREATED, CHANGE_UPDATED, JOP_TYPE_NOTE, type JoplinItemRow } from "../lib/joplin-types.js";
import type { Core } from "./core.js";

export interface NoteStore {
  /** Title/body ILIKE search, optionally restricted to one notebook (parent jop_id). */
  search(userId: string, params: { query: string; parentJopId?: string; limit: number }): Promise<JoplinItemRow[]>;
  /** Most recent notes, optionally restricted to one notebook. */
  listRecent(userId: string, params: { parentJopId?: string; limit: number }): Promise<JoplinItemRow[]>;
  createNote(params: {
    title: string;
    body: string;
    parentJopId: string;
    extra: Record<string, any>;
    userId: string;
  }): Promise<{ id: string; jopId: string }>;
  /** Rewrite the body and emit the sync event; a delete keeps the default change item type. */
  writeNoteContent(
    note: { id: string; jop_id: string },
    content: Buffer,
    userId: string,
    changeType: number,
    changeItemType?: number,
  ): Promise<void>;
  /** Re-parent a note in the column the clients read, and emit the sync event. */
  moveNote(note: { id: string; jop_id: string }, parentJopId: string, userId: string): Promise<void>;
}

export function createNoteStore(pool: Pool, core: Core): NoteStore {
  return {
    async search(userId, params) {
      const conditions = ["i.owner_id = $1", "i.jop_type = $2", "encode(i.content, 'escape') ILIKE $3"];
      const values: any[] = [userId, JOP_TYPE_NOTE, `%${params.query}%`];
      if (params.parentJopId !== undefined) {
        values.push(params.parentJopId);
        conditions.push(`i.jop_parent_id = $${values.length}`);
      }
      values.push(Math.min(params.limit, 50));
      const result = await pool.query(
        `SELECT i.id, i.content, i.updated_time FROM items i
         WHERE ${conditions.join(" AND ")}
         ORDER BY i.updated_time DESC LIMIT $${values.length}`,
        values,
      );
      return result.rows;
    },

    async listRecent(userId, params) {
      const result =
        params.parentJopId !== undefined
          ? await pool.query(
              `SELECT i.id, i.content, i.updated_time FROM items i
               WHERE i.owner_id = $1 AND i.jop_type = $2 AND i.jop_parent_id = $3 ORDER BY i.updated_time DESC LIMIT $4`,
              [userId, JOP_TYPE_NOTE, params.parentJopId, Math.min(params.limit, 50)],
            )
          : await pool.query(
              `SELECT i.id, i.content, i.updated_time FROM items i
               WHERE i.owner_id = $1 AND i.jop_type = $2 ORDER BY i.updated_time DESC LIMIT $3`,
              [userId, JOP_TYPE_NOTE, Math.min(params.limit, 50)],
            );
      return result.rows;
    },

    async createNote(params) {
      const { title, body, parentJopId, extra, userId } = params;
      const noteId = generateId();
      const now = Date.now();
      const jopId = generateJopId();
      const contentBytes = buildNoteContent(title, body, extra);
      await pool.query(
        `INSERT INTO items (id, name, mime_type, updated_time, created_time, content, content_size, jop_id, jop_parent_id, jop_share_id, jop_type, jop_encryption_applied, jop_updated_time, owner_id, content_storage_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          noteId,
          `${jopId}.md`,
          "text/markdown",
          now,
          now,
          contentBytes,
          contentBytes.length,
          jopId,
          parentJopId,
          "",
          JOP_TYPE_NOTE,
          0,
          now,
          userId,
          1,
        ],
      );
      // Ownership and change event: without them a synced client never sees the note
      await core.recordUserItem({ itemId: noteId, userId });
      await core.recordChange({ itemId: noteId, itemType: JOP_TYPE_NOTE, changeType: CHANGE_CREATED, jopId, userId });
      return { id: noteId, jopId };
    },

    async writeNoteContent(note, content, userId, changeType, changeItemType) {
      await core.updateItemContent({ id: note.id, content });
      await core.recordChange({
        itemId: note.id,
        itemType: JOP_TYPE_NOTE,
        changeType,
        jopId: note.jop_id,
        userId,
        changeItemType,
      });
    },

    async moveNote(note, parentJopId, userId) {
      const now = Date.now();
      await pool.query("UPDATE items SET jop_parent_id = $1, updated_time = $2, jop_updated_time = $3 WHERE id = $4", [
        parentJopId,
        now,
        now,
        note.id,
      ]);
      await core.recordChange({
        itemId: note.id,
        itemType: JOP_TYPE_NOTE,
        changeType: CHANGE_UPDATED,
        jopId: note.jop_id,
        userId,
        changeItemType: 1,
      });
    },
  };
}
