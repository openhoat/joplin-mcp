/**
 * Trash store: deleted items are ordinary rows whose body carries a
 * non-zero `deleted_time`; restoring clears that field and records an update,
 * which is what brings the item back on synced clients.
 */

import type { Pool } from "pg";
import { parseRawJson } from "../lib/content.js";
import { CHANGE_UPDATED, type JoplinItemRow } from "../lib/joplin-types.js";
import type { Core } from "./core.js";

export interface TrashStore {
  /** Notes and/or resources sitting in the trash, most recently updated first. */
  listTrashed(userId: string, types: number[], limit: number): Promise<JoplinItemRow[]>;
  /** Clear deleted_time, keep every id, and emit the sync event. */
  restore(item: JoplinItemRow, userId: string): Promise<void>;
}

export function createTrashStore(pool: Pool, core: Core): TrashStore {
  return {
    async listTrashed(userId, types, limit) {
      const result = await pool.query(
        `SELECT id, name, content, jop_id, jop_type, content_size, updated_time
         FROM items
         WHERE owner_id = $1 AND jop_type = ANY($2::int[])
           AND encode(content, 'escape') ~ '"deleted_time"[[:space:]]*:[[:space:]]*[1-9]'
         ORDER BY updated_time DESC LIMIT $3`,
        [userId, types, Math.min(limit, 200)],
      );
      return result.rows;
    },

    async restore(item, userId) {
      const now = Date.now();
      const json = parseRawJson(item.content);
      const contentBytes = Buffer.from(JSON.stringify({ ...json, deleted_time: 0, user_updated_time: now }), "utf-8");
      await core.updateItemContent({ id: item.id, content: contentBytes });
      await core.recordChange({
        itemId: item.id,
        itemType: item.jop_type,
        changeType: CHANGE_UPDATED,
        jopId: item.jop_id,
        userId,
        changeItemType: 1,
      });
    },
  };
}
