/**
 * Tag store.
 *
 * A tag and a note<->tag assignment are both plain items: jop_type 5 for the
 * tag, 6 for the relation (the relation body carries `tag_id` and `note_id` as
 * jop_ids). Assignments are soft-deleted, exactly like the desktop does.
 */

import type { Pool } from "pg";
import { buildNoteTagContent, buildTagContent, parseJoplinContent, parseRawJson } from "../lib/content.js";
import { generateId, generateJopId } from "../lib/ids.js";
import {
  CHANGE_CREATED,
  CHANGE_DELETED,
  CHANGE_UPDATED,
  JOP_TYPE_NOTE_TAG,
  JOP_TYPE_TAG,
  type JoplinItemRow,
} from "../lib/joplin-types.js";
import type { Core } from "./core.js";

export interface RelationRow {
  id: string;
  jop_id: string;
  content: string | Buffer;
}

export interface TagStore {
  listTags(userId: string): Promise<JoplinItemRow[]>;
  /** Every note<->tag relation of the account, deleted ones included. */
  listRelations(userId: string): Promise<RelationRow[]>;
  /** Tag with this exact title (case-insensitive prefilter, exact match), deleted tags excluded. */
  findTagByTitle(userId: string, title: string): Promise<{ id: string; content: string | Buffer } | null>;
  createTag(params: { title: string; userId: string }): Promise<{ id: string; jopId: string }>;
  createAssignment(params: { tagJopId: string; noteJopId: string; userId: string }): Promise<{ id: string; jopId: string }>;
  /** Soft delete a batch of assignments; returns how many were touched. */
  softDeleteAssignments(relations: RelationRow[], userId: string): Promise<number>;
  renameTag(tag: { id: string; jop_id: string; content: string | Buffer }, title: string, userId: string): Promise<void>;
  softDeleteTag(tag: { id: string; jop_id: string; content: string | Buffer }, userId: string): Promise<void>;
}

export function createTagStore(pool: Pool, core: Core): TagStore {
  const insertItem = async (id: string, jopId: string, contentBytes: Buffer, jopType: number, userId: string): Promise<void> => {
    const now = Date.now();
    await pool.query(
      `INSERT INTO items (id, name, mime_type, updated_time, created_time, content, content_size, jop_id, jop_parent_id, jop_share_id, jop_type, jop_encryption_applied, jop_updated_time, owner_id, content_storage_id)
       VALUES ($1, $2, 'text/markdown', $3, $3, $4, $5, $6, '', '', $7, 0, $3, $8, 1)`,
      [id, `${jopId}.md`, now, contentBytes, contentBytes.length, jopId, jopType, userId],
    );
    await core.recordUserItem({ itemId: id, userId });
    await core.recordChange({ itemId: id, itemType: jopType, changeType: CHANGE_CREATED, jopId, userId, changeItemType: 2 });
  };

  return {
    async listTags(userId) {
      const result = await pool.query(
        `SELECT id, name, content, jop_id, jop_parent_id, jop_type, content_size, updated_time
         FROM items WHERE owner_id = $1 AND jop_type = $2 ORDER BY updated_time DESC`,
        [userId, JOP_TYPE_TAG],
      );
      return result.rows;
    },

    async listRelations(userId) {
      const result = await pool.query("SELECT id, content, jop_id FROM items WHERE owner_id = $1 AND jop_type = $2", [
        userId,
        JOP_TYPE_NOTE_TAG,
      ]);
      return result.rows;
    },

    async findTagByTitle(userId, title) {
      const result = await pool.query(
        "SELECT id, content FROM items WHERE owner_id = $1 AND jop_type = $2 AND encode(content, 'escape') ILIKE $3",
        [userId, JOP_TYPE_TAG, `%${title}%`],
      );
      const match = result.rows.find((row: any) => {
        const parsed = parseJoplinContent(row.content);
        return parsed.title === title && !parsed.isDeleted;
      });
      return match || null;
    },

    async createTag(params) {
      const id = generateId();
      const jopId = generateJopId();
      await insertItem(id, jopId, buildTagContent(params.title, Date.now()), JOP_TYPE_TAG, params.userId);
      return { id, jopId };
    },

    async createAssignment(params) {
      const id = generateId();
      const jopId = generateJopId();
      const contentBytes = buildNoteTagContent(params.tagJopId, params.noteJopId, Date.now());
      await insertItem(id, jopId, contentBytes, JOP_TYPE_NOTE_TAG, params.userId);
      return { id, jopId };
    },

    async softDeleteAssignments(relations, userId) {
      const now = Date.now();
      for (const relation of relations) {
        const json = { ...parseRawJson(relation.content), deleted_time: now, user_updated_time: now };
        const contentBytes = Buffer.from(JSON.stringify(json), "utf-8");
        await core.updateItemContent({ id: relation.id, content: contentBytes });
        await core.recordChange({
          itemId: relation.id,
          itemType: JOP_TYPE_NOTE_TAG,
          changeType: CHANGE_DELETED,
          jopId: relation.jop_id,
          userId,
          changeItemType: 2,
        });
      }
      return relations.length;
    },

    async renameTag(tag, title, userId) {
      const now = Date.now();
      const contentBytes = Buffer.from(JSON.stringify({ ...parseRawJson(tag.content), title, user_updated_time: now }), "utf-8");
      await core.updateItemContent({ id: tag.id, content: contentBytes });
      await core.recordChange({
        itemId: tag.id,
        itemType: JOP_TYPE_TAG,
        changeType: CHANGE_UPDATED,
        jopId: tag.jop_id,
        userId,
        changeItemType: 1,
      });
    },

    async softDeleteTag(tag, userId) {
      const now = Date.now();
      const contentBytes = Buffer.from(
        JSON.stringify({ ...parseRawJson(tag.content), deleted_time: now, user_updated_time: now }),
        "utf-8",
      );
      await core.updateItemContent({ id: tag.id, content: contentBytes });
      await core.recordChange({
        itemId: tag.id,
        itemType: JOP_TYPE_TAG,
        changeType: CHANGE_DELETED,
        jopId: tag.jop_id,
        userId,
        changeItemType: 2,
      });
    },
  };
}
