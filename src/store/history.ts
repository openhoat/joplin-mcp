/**
 * Note history and conflict listing.
 *
 * History rows (jop_type 13) are written by Joplin Server on every item save;
 * they are read-only for us. Conflict flags live in the note body itself, so
 * the query matches the JSON field rather than a column.
 */

import type { Pool } from "pg";
import { JOP_TYPE_HISTORY, JOP_TYPE_NOTE } from "../lib/joplin-types.js";

export interface HistoryRow {
  id: string;
  content: Buffer;
  updated_time: number;
}

export interface HistoryStore {
  /** Notes carrying `is_conflict: 1`, most recently updated first. */
  listConflictedNotes(userId: string, limit: number): Promise<HistoryRow[]>;
  /** History entries recorded for a note, in no particular order. */
  listHistoryEntries(userId: string, noteJopId: string): Promise<HistoryRow[]>;
}

export function createHistoryStore(pool: Pool): HistoryStore {
  return {
    async listConflictedNotes(userId, limit) {
      const result = await pool.query(
        `SELECT id, content, jop_parent_id, updated_time FROM items
         WHERE owner_id = $1 AND jop_type = $2
           AND encode(content, 'escape') ~ '"is_conflict"[[:space:]]*:[[:space:]]*1'
         ORDER BY updated_time DESC LIMIT $3`,
        [userId, JOP_TYPE_NOTE, Math.min(limit, 200)],
      );
      return result.rows;
    },

    async listHistoryEntries(userId, noteJopId) {
      const result = await pool.query(
        `SELECT id, content, updated_time FROM items
         WHERE owner_id = $1 AND jop_type = $2 AND encode(content, 'escape') LIKE $3`,
        [userId, JOP_TYPE_HISTORY, `%"item_id":"${noteJopId}"%`],
      );
      return result.rows;
    },
  };
}
