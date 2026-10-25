/**
 * Attachment store: metadata item, blob row, the note → resource index and the
 * markdown link inside a note body.
 *
 * The blob is an ordinary `items` row named `.resource/<jop_id>`; replacing an
 * attachment rewrites that row in place, so ids and `:/` links survive.
 */

import type { Pool } from "pg";
import { buildNoteContent, buildResourceContent, parseJoplinContent, parseRawJson } from "../lib/content.js";
import { fileExtensionFromName, guessMime } from "../lib/format.js";
import { generateId, generateJopId } from "../lib/ids.js";
import {
  CHANGE_CREATED,
  CHANGE_DELETED,
  CHANGE_UPDATED,
  JOP_TYPE_BLOB,
  JOP_TYPE_NOTE,
  JOP_TYPE_RESOURCE,
  type JoplinItemRow,
  RESOURCE_BLOB_PREFIX,
} from "../lib/joplin-types.js";
import { buildResourceLink } from "../lib/markdown.js";
import type { Core } from "./core.js";

export interface ResourceStore {
  /** Full upload, like a desktop client: metadata item, blob item, ownership, changes. */
  createResource(params: { title: string; data: Buffer; mime?: string; userId: string }): Promise<{
    id: string;
    jopId: string;
    title: string;
    mime: string;
    size: number;
  }>;
  /** Read the blob row holding the resource bytes. */
  findResourceBlob(resourceJopId: string, userId: string): Promise<{ id: string; content: Buffer; content_size: number } | null>;
  /** New bytes in the same rows: ids and every `:/` link keep working. */
  replaceResourceContent(params: {
    resource: JoplinItemRow;
    data: Buffer;
    mime?: string;
    filename?: string;
    userId: string;
  }): Promise<{ id: string; jopId: string; title: string; mime: string; sizeBefore: number; size: number }>;
  /** Append a markdown resource link to a note body; the desktop derives its dependencies from it. */
  appendResourceLinkToNote(note: JoplinItemRow, resourceTitle: string, resourceJopId: string, asImage: boolean): Promise<void>;
  /** Remove every markdown link pointing at the resource. Returns the removed count. */
  removeResourceLinksFromNote(note: JoplinItemRow, resourceJopId: string): Promise<number>;
  /** Resource ids referenced by a note: indexed table first, note body as a fallback. */
  listNoteResourceIds(note: JoplinItemRow): Promise<string[]>;
  /** Resources referenced by their client-facing jop_id, for a note attachment listing. */
  listResourcesByJopIds(userId: string, jopIds: string[], limit: number): Promise<JoplinItemRow[]>;
  /** Most recently updated resources, optionally filtered on the title. */
  listResources(userId: string, params: { query?: string; limit: number }): Promise<JoplinItemRow[]>;
  /** Notes referencing the resource (item ids), from the server-side index. */
  listResourceLinks(resourceJopId: string): Promise<string[]>;
  /** Note titles for a set of item ids, falling back to the id when untitled. */
  listNoteTitles(itemIds: string[]): Promise<string[]>;
  /** Soft delete: keep the row and the blob, stamp deleted_time, emit the sync event. */
  softDeleteResource(resource: JoplinItemRow, userId: string): Promise<void>;
}

export function createResourceStore(pool: Pool, core: Core): ResourceStore {
  /** Keep the server-side note → resource index in sync (derived by Joplin Server on item save). */
  const linkUsage = async (noteItemId: string, resourceJopId: string): Promise<void> => {
    try {
      await pool.query(
        `INSERT INTO item_resources (item_id, resource_id)
         SELECT $1::varchar, $2::varchar WHERE NOT EXISTS (
           SELECT 1 FROM item_resources WHERE item_id = $1::varchar AND resource_id = $2::varchar
         )`,
        [noteItemId, resourceJopId],
      );
    } catch (error: any) {
      console.warn(`item_resources insert skipped: ${error.message}`);
    }
  };

  const unlinkUsage = async (noteItemId: string, resourceJopId: string): Promise<void> => {
    try {
      await pool.query("DELETE FROM item_resources WHERE item_id = $1 AND resource_id = $2", [noteItemId, resourceJopId]);
    } catch (error: any) {
      console.warn(`item_resources delete skipped: ${error.message}`);
    }
  };

  /** Everything except the note body, which the two link helpers rewrite. */
  const noteExtras = (json: Record<string, any> | null): Record<string, any> => {
    const extra: Record<string, any> = {};
    if (json) {
      for (const [key, value] of Object.entries(json)) {
        if (!["title", "body", "source", "source_url"].includes(key)) {
          extra[key] = value;
        }
      }
    }
    return extra;
  };

  const writeNoteBody = async (note: JoplinItemRow, body: string, json: Record<string, any>): Promise<void> => {
    const now = Date.now();
    // `json` comes from the strict parseRawJson: a document we could not read
    // failed before this point instead of being rewritten from scratch.
    const contentBytes = buildNoteContent(json.title || "(untitled)", body, { ...noteExtras(json), user_updated_time: now });
    await pool.query("UPDATE items SET content = $1, content_size = $2, updated_time = $3, jop_updated_time = $3 WHERE id = $4", [
      contentBytes,
      contentBytes.length,
      now,
      note.id,
    ]);
    await core.recordChange({
      itemId: note.id,
      itemType: JOP_TYPE_NOTE,
      changeType: CHANGE_UPDATED,
      jopId: note.jop_id,
      userId: await core.resolveUserId(),
      changeItemType: 1,
    });
  };

  return {
    async createResource(params) {
      const { title, data, userId } = params;
      const mime = params.mime && params.mime !== "application/octet-stream" ? params.mime : guessMime(title);
      const now = Date.now();
      const jopId = generateJopId();
      const resourceId = generateId();
      const blobId = generateId();
      const contentBytes = buildResourceContent({ title, mime, size: data.length, now });

      await pool.query(
        `INSERT INTO items (id, name, mime_type, updated_time, created_time, content, content_size, jop_id, jop_parent_id, jop_share_id, jop_type, jop_encryption_applied, jop_updated_time, owner_id, content_storage_id)
         VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9, $10, $11, $4, $12, $13)`,
        [
          resourceId,
          `${jopId}.md`,
          "text/markdown",
          now,
          contentBytes,
          contentBytes.length,
          jopId,
          "",
          "",
          JOP_TYPE_RESOURCE,
          0,
          userId,
          1,
        ],
      );
      await core.recordUserItem({ itemId: resourceId, userId });
      await core.recordChange({
        itemId: resourceId,
        itemType: JOP_TYPE_RESOURCE,
        changeType: CHANGE_CREATED,
        jopId,
        userId,
        changeItemType: 2,
      });

      await pool.query(
        `INSERT INTO items (id, name, mime_type, updated_time, created_time, content, content_size, jop_id, jop_parent_id, jop_share_id, jop_type, jop_encryption_applied, jop_updated_time, owner_id, content_storage_id)
         VALUES ($1, $2, '', $3, $3, $4, $5, '', '', '', $6, 0, 0, $7, 1)`,
        [blobId, `${RESOURCE_BLOB_PREFIX}${jopId}`, now, data, data.length, JOP_TYPE_BLOB, userId],
      );
      await core.recordUserItem({ itemId: blobId, userId });
      await core.recordChange({
        itemId: blobId,
        itemType: JOP_TYPE_BLOB,
        changeType: CHANGE_CREATED,
        jopId,
        userId,
        itemName: `${RESOURCE_BLOB_PREFIX}${jopId}`,
        changeItemType: 2,
      });

      return { id: resourceId, jopId, title, mime, size: data.length };
    },

    async findResourceBlob(resourceJopId, userId) {
      const result = await pool.query("SELECT id, content, content_size FROM items WHERE owner_id = $1 AND name = $2 LIMIT 1", [
        userId,
        `${RESOURCE_BLOB_PREFIX}${resourceJopId}`,
      ]);
      if (result.rows.length === 0) {
        return null;
      }
      const row = result.rows[0];
      return {
        id: row.id,
        content: Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content || ""),
        content_size: Number(row.content_size),
      };
    },

    async replaceResourceContent(params) {
      const { resource, data, userId } = params;
      const json = parseRawJson(resource.content);
      const blob = await pool.query("SELECT id FROM items WHERE owner_id = $1 AND name = $2 LIMIT 1", [
        userId,
        `${RESOURCE_BLOB_PREFIX}${resource.jop_id}`,
      ]);
      if (blob.rows.length === 0) {
        throw new Error("no binary content for this resource");
      }
      const now = Date.now();
      const title = String(params.filename || json.title || "").trim() || "file";
      const mime = params.mime || (params.filename ? guessMime(params.filename) : String(json.mime || guessMime(title)));
      const meta = {
        ...json,
        title,
        mime,
        file_extension: fileExtensionFromName(title) || String(json.file_extension || ""),
        size: data.length,
        blob_updated_time: now,
        user_updated_time: now,
      };
      const metaBytes = Buffer.from(JSON.stringify(meta), "utf-8");
      await pool.query("UPDATE items SET content = $1, content_size = $2, updated_time = $3, jop_updated_time = $3 WHERE id = $4", [
        metaBytes,
        metaBytes.length,
        now,
        resource.id,
      ]);
      // Blob rows keep jop_updated_time at 0, like the desktop writes them.
      await pool.query("UPDATE items SET content = $1, content_size = $2, updated_time = $3 WHERE id = $4", [
        data,
        data.length,
        now,
        blob.rows[0].id,
      ]);
      await core.recordChange({
        itemId: blob.rows[0].id,
        itemType: JOP_TYPE_BLOB,
        changeType: CHANGE_UPDATED,
        jopId: resource.jop_id,
        userId,
        itemName: `${RESOURCE_BLOB_PREFIX}${resource.jop_id}`,
        changeItemType: 1,
      });
      await core.recordChange({
        itemId: resource.id,
        itemType: JOP_TYPE_RESOURCE,
        changeType: CHANGE_UPDATED,
        jopId: resource.jop_id,
        userId,
        changeItemType: 1,
      });
      return { id: resource.id, jopId: resource.jop_id, title, mime, sizeBefore: Number(json.size || 0), size: data.length };
    },

    async appendResourceLinkToNote(note, resourceTitle, resourceJopId, asImage) {
      const parsed = parseJoplinContent(note.content);
      const trimmed = parsed.body.replace(/\s+$/, "");
      const link = buildResourceLink(resourceTitle, resourceJopId, asImage);
      const newBody = `${trimmed}${trimmed ? "\n" : ""}${link}\n`;
      await writeNoteBody(note, newBody, parseRawJson(note.content));
      await linkUsage(note.id, resourceJopId);
    },

    async removeResourceLinksFromNote(note, resourceJopId) {
      const parsed = parseJoplinContent(note.content);
      const pattern = new RegExp(`!?\\[[^\\]]*\\]\\(:/${resourceJopId}\\)`, "g");
      const occurrences = (parsed.body.match(pattern) || []).length;
      await unlinkUsage(note.id, resourceJopId);
      if (occurrences === 0) {
        return 0;
      }
      const newBody = parsed.body
        .replace(pattern, "")
        .replace(/[ \t]+$/gm, "")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/\s+$/, "");
      await writeNoteBody(note, newBody, parseRawJson(note.content));
      return occurrences;
    },

    async listNoteResourceIds(note) {
      const indexed = await pool.query("SELECT resource_id FROM item_resources WHERE item_id = $1", [note.id]);
      const ids = new Set<string>(indexed.rows.map((row: any) => String(row.resource_id)));
      const body = parseJoplinContent(note.content).body;
      const pattern = /\(:\/([0-9a-f]{32})\)/g;
      let match: RegExpExecArray | null = pattern.exec(body);
      while (match !== null) {
        ids.add(match[1]);
        match = pattern.exec(body);
      }
      return Array.from(ids);
    },

    async listResourcesByJopIds(userId, jopIds, limit) {
      const result = await pool.query(
        `SELECT id, name, content, jop_id, jop_parent_id, jop_type, content_size, updated_time
         FROM items WHERE owner_id = $1 AND jop_type = $2 AND jop_id = ANY($3::text[])
         ORDER BY updated_time DESC LIMIT $4`,
        [userId, JOP_TYPE_RESOURCE, jopIds, Math.min(limit, 200)],
      );
      return result.rows;
    },

    async listResources(userId, params) {
      const conditions = ["owner_id = $1", "jop_type = $2"];
      const values: any[] = [userId, JOP_TYPE_RESOURCE];
      if (params.query) {
        values.push(`%${params.query}%`);
        conditions.push(`encode(content, 'escape') ILIKE $${values.length}`);
      }
      values.push(Math.min(params.limit, 100));
      const result = await pool.query(
        `SELECT id, name, content, jop_id, jop_parent_id, jop_type, content_size, updated_time
         FROM items WHERE ${conditions.join(" AND ")}
         ORDER BY updated_time DESC LIMIT $${values.length}`,
        values,
      );
      return result.rows;
    },

    async listResourceLinks(resourceJopId) {
      const result = await pool.query("SELECT item_id FROM item_resources WHERE resource_id = $1", [resourceJopId]);
      return result.rows.map((row: any) => String(row.item_id));
    },

    async listNoteTitles(itemIds) {
      if (itemIds.length === 0) {
        return [];
      }
      const result = await pool.query("SELECT id, content FROM items WHERE id = ANY($1::text[])", [itemIds]);
      return result.rows.map((row: any) => parseJoplinContent(row.content).title || String(row.id));
    },

    async softDeleteResource(resource, userId) {
      const now = Date.now();
      const json = { ...parseRawJson(resource.content), deleted_time: now, user_updated_time: now };
      const contentBytes = Buffer.from(JSON.stringify(json), "utf-8");
      await core.updateItemContent({ id: resource.id, content: contentBytes });
      await core.recordChange({
        itemId: resource.id,
        itemType: JOP_TYPE_RESOURCE,
        changeType: CHANGE_DELETED,
        jopId: resource.jop_id,
        userId,
        changeItemType: 2,
      });
    },
  };
}
