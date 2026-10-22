/** Read-only view of a resource item, as printed by `get_resource`. */

import { parseRawJson } from "./content.js";
import { fileExtensionFromName, formatTimestamp, guessMime } from "./format.js";
import type { JoplinItemRow } from "./joplin-types.js";

export type ResourceSummary = {
  id: string;
  jopId: string;
  title: string;
  mime: string;
  size: number;
  updated: string;
  fileExtension: string;
  isDeleted: boolean;
};

export function resourceSummary(row: JoplinItemRow): ResourceSummary {
  const json = parseRawJson(row.content);
  const title = String(json.title || "(untitled)");
  return {
    id: row.id,
    jopId: row.jop_id,
    title,
    mime: String(json.mime || guessMime(title)),
    size: Number(json.size || 0),
    updated: formatTimestamp(Number(row.updated_time)),
    fileExtension: String(json.file_extension || fileExtensionFromName(title)),
    isDeleted: Number(json.deleted_time || 0) > 0,
  };
}
