/**
 * Joplin Server item types and shared row shapes.
 *
 * The values below are the wire contract of the `items` table: they are read and
 * written by Joplin clients during sync, so they must not be renumbered.
 */

/** jop_type values of the `items` table. */
export const JOP_TYPE_NOTE = 1;
export const JOP_TYPE_FOLDER = 2;
export const JOP_TYPE_RESOURCE = 4;
export const JOP_TYPE_TAG = 5;
export const JOP_TYPE_NOTE_TAG = 6;
/**
 * Resource file content lives in plain `items` rows: jop_type 0, empty jop_id,
 * mime_type '', an empty jop_updated_time, and a ".resource/<resource jop_id>" name.
 */
export const JOP_TYPE_BLOB = 0;
/**
 * Server-side note history entries: written by Joplin Server on every item save,
 * never by us. Read-only (`get_note_history`).
 */
export const JOP_TYPE_HISTORY = 13;

/** Sync name prefix of resource blob rows. */
export const RESOURCE_BLOB_PREFIX = ".resource/";

/** Change types of the `changes` / `changes_2` tables. */
export const CHANGE_CREATED = 1;
export const CHANGE_UPDATED = 2;
export const CHANGE_DELETED = 3;

/** A row of the `items` table as selected by the MCP server. */
export type JoplinItemRow = {
  id: string;
  name: string;
  content: Buffer | string | null;
  jop_id: string;
  jop_parent_id: string;
  jop_type: number;
  content_size: number;
  updated_time: number;
};

/**
 * Notebook icon, as stored in the folder `icon` field.
 * In Joplin v3 content, `icon` is a STRING containing a compact JSON object
 * (e.g. "{\"emoji\":\"🏦\",\"name\":\"bank\",\"type\":1}"), not a nested object.
 */
export type NotebookIcon = { emoji?: string; name?: string; type?: number };
