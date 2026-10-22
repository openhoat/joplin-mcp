/**
 * Notebook (folder) store.
 *
 * A notebook is an ordinary `items` row with jop_type 2. Nesting lives in the
 * `jop_parent_id` column (the parent's 32-hex jop_id) and in the `parent_id`
 * body field; both are written so clients and the tree agree.
 */

import type { Pool } from "pg";
import { parseJoplinContent, parseRawJson } from "../lib/content.js";
import { generateId, generateJopId } from "../lib/ids.js";
import { CHANGE_CREATED, CHANGE_DELETED, CHANGE_UPDATED, JOP_TYPE_FOLDER, JOP_TYPE_NOTE } from "../lib/joplin-types.js";
import type { Core } from "./core.js";

export interface NotebookRow {
  id: string;
  jop_id: string;
  jop_parent_id: string;
  content: Buffer;
  updated_time: number;
}

export interface NoteRow {
  id: string;
  content: Buffer;
  updated_time: number;
}

export interface NotebookStore {
  listFolders(userId: string): Promise<NotebookRow[]>;
  /** Title search, most recently updated first. */
  searchFolders(userId: string, query: string, limit: number): Promise<NotebookRow[]>;
  /** Live notes per parent jop_id, for the tree note counts. */
  countNotesPerFolder(userId: string): Promise<Map<string, number>>;
  createFolder(params: { title: string; parentJopId: string; icon: string; userId: string }): Promise<{ id: string; jopId: string }>;
  /** Rename and/or set the icon; every other field is preserved. */
  updateFolder(
    folder: { id: string; jop_id: string; content: string | Buffer },
    patch: { title?: string; icon?: string },
    userId: string,
  ): Promise<void>;
  /** Re-parent a notebook, in the column and in the body. */
  moveFolder(folder: { id: string; jop_id: string; content: string | Buffer }, parentJopId: string, userId: string): Promise<void>;
  softDeleteFolder(folder: { id: string; jop_id: string; content: string | Buffer }, userId: string): Promise<void>;
  /** Notes and sub-notebooks still alive under a notebook. */
  countAliveChildren(parentJopId: string, userId: string): Promise<number>;
  listNotesInFolder(parentJopId: string, limit: number): Promise<NoteRow[]>;
}

export function createNotebookStore(pool: Pool, core: Core): NotebookStore {
  return {
    async listFolders(userId) {
      const result = await pool.query(
        "SELECT id, jop_id, jop_parent_id, content, updated_time FROM items WHERE owner_id = $1 AND jop_type = $2 ORDER BY updated_time DESC",
        [userId, JOP_TYPE_FOLDER],
      );
      return result.rows;
    },

    async searchFolders(userId, query, limit) {
      const result = await pool.query(
        `SELECT i.id, i.jop_id, i.jop_parent_id, i.content, i.updated_time FROM items i
         WHERE i.owner_id = $1 AND i.jop_type = $2 AND encode(i.content, 'escape') ILIKE $3
         ORDER BY i.updated_time DESC LIMIT $4`,
        [userId, JOP_TYPE_FOLDER, `%${query}%`, Math.min(limit, 50)],
      );
      return result.rows;
    },

    async countNotesPerFolder(userId) {
      const result = await pool.query("SELECT content, jop_parent_id FROM items WHERE owner_id = $1 AND jop_type = $2", [
        userId,
        JOP_TYPE_NOTE,
      ]);
      const counts = new Map<string, number>();
      for (const row of result.rows) {
        if (parseJoplinContent(row.content).isDeleted) continue;
        const parent = String(row.jop_parent_id || "");
        counts.set(parent, (counts.get(parent) || 0) + 1);
      }
      return counts;
    },

    async createFolder(params) {
      const { title, parentJopId, icon, userId } = params;
      const folderId = generateId();
      const now = Date.now();
      const jopId = generateJopId();
      const contentBytes = Buffer.from(
        JSON.stringify({
          title,
          deleted_time: 0,
          user_data: "",
          icon,
          master_key_id: "",
          is_shared: 0,
          encryption_cipher_text: "",
          user_updated_time: now,
          user_created_time: now,
        }),
        "utf-8",
      );
      await pool.query(
        `INSERT INTO items (id, name, mime_type, updated_time, created_time, content, content_size, jop_id, jop_parent_id, jop_share_id, jop_type, jop_encryption_applied, jop_updated_time, owner_id, content_storage_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          folderId,
          `${jopId}.md`,
          "text/markdown",
          now,
          now,
          contentBytes,
          contentBytes.length,
          jopId,
          parentJopId,
          "",
          JOP_TYPE_FOLDER,
          0,
          now,
          userId,
          1,
        ],
      );
      // Ownership and change event: without them a synced client never sees the notebook
      await core.recordUserItem({ itemId: folderId, userId });
      await core.recordChange({ itemId: folderId, itemType: JOP_TYPE_FOLDER, changeType: CHANGE_CREATED, jopId, userId });
      return { id: folderId, jopId };
    },

    async updateFolder(folder, patch, userId) {
      const now = Date.now();
      const json: Record<string, any> = { ...parseRawJson(folder.content), user_updated_time: now };
      if (patch.title !== undefined) json.title = patch.title;
      if (patch.icon !== undefined) json.icon = patch.icon;
      const contentBytes = Buffer.from(JSON.stringify(json), "utf-8");
      await pool.query("UPDATE items SET content = $1, content_size = $2, updated_time = $3, jop_updated_time = $4 WHERE id = $5", [
        contentBytes,
        contentBytes.length,
        now,
        now,
        folder.id,
      ]);
      await core.recordChange({ itemId: folder.id, itemType: JOP_TYPE_FOLDER, changeType: CHANGE_UPDATED, jopId: folder.jop_id, userId });
    },

    async moveFolder(folder, parentJopId, userId) {
      const now = Date.now();
      const contentBytes = Buffer.from(
        JSON.stringify({ ...parseRawJson(folder.content), parent_id: parentJopId, user_updated_time: now }),
        "utf-8",
      );
      await pool.query(
        "UPDATE items SET content = $1, content_size = $2, updated_time = $3, jop_updated_time = $3, jop_parent_id = $4 WHERE id = $5",
        [contentBytes, contentBytes.length, now, parentJopId, folder.id],
      );
      await core.recordChange({
        itemId: folder.id,
        itemType: JOP_TYPE_FOLDER,
        changeType: CHANGE_UPDATED,
        jopId: folder.jop_id,
        userId,
        changeItemType: 1,
      });
    },

    async softDeleteFolder(folder, userId) {
      const now = Date.now();
      const json = { ...parseRawJson(folder.content), deleted_time: now, user_updated_time: now };
      const contentBytes = Buffer.from(JSON.stringify(json), "utf-8");
      await pool.query("UPDATE items SET content = $1, content_size = $2, updated_time = $3, jop_updated_time = $4 WHERE id = $5", [
        contentBytes,
        contentBytes.length,
        now,
        now,
        folder.id,
      ]);
      await core.recordChange({ itemId: folder.id, itemType: JOP_TYPE_FOLDER, changeType: CHANGE_DELETED, jopId: folder.jop_id, userId });
    },

    async countAliveChildren(parentJopId, userId) {
      const result = await pool.query("SELECT id, content FROM items WHERE jop_parent_id = $1 AND owner_id = $2", [parentJopId, userId]);
      return result.rows.filter((row: any) => !parseJoplinContent(row.content).isDeleted).length;
    },

    async listNotesInFolder(parentJopId, limit) {
      const result = await pool.query(
        `SELECT i.id, i.content, i.updated_time FROM items i
         WHERE i.jop_parent_id = $1 AND i.jop_type = $2
         ORDER BY i.updated_time DESC LIMIT $3`,
        [parentJopId, JOP_TYPE_NOTE, Math.min(limit, 50)],
      );
      return result.rows;
    },
  };
}
