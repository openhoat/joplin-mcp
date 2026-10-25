/** Reading and building the Joplin v3 JSON item content. */

import { fileExtensionFromName } from "./format.js";
import type { NotebookIcon } from "./joplin-types.js";

export type JoplinContent = {
  title: string;
  body: string;
  isDeleted: boolean;
  json: Record<string, any> | null;
};

export function readContent(raw: Buffer | string | null): string {
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf-8");
  return String(raw);
}

/**
 * Lenient parse used by display paths: a row that is not valid v3 JSON is shown
 * as its raw text rather than failing the read. Anything that rewrites a stored
 * document must go through `parseRawJson`, which throws instead of guessing.
 */
export function parseJoplinContent(raw: Buffer | string | null): JoplinContent {
  const content = readContent(raw);
  if (!content) return { title: "(untitled)", body: "", isDeleted: false, json: null };

  try {
    // Remove problematic "icon" field that contains nested JSON with emojis that breaks JSON.parse
    const cleanContent = content.replace(/"icon"\s*:\s*"\{[^}]*\}"/g, '"icon":""');
    const parsed = JSON.parse(cleanContent);
    return {
      title: parsed.title || "(untitled)",
      body: parsed.body || parsed.markdown || "",
      isDeleted: (parsed.deleted_time && parsed.deleted_time > 0) || parsed.is_todo === 2,
      json: parsed,
    };
  } catch {
    // Fallback: old format where title is first line before double newline
    if (content.includes("\n\n")) {
      const parts = content.split("\n\n");
      return { title: parts[0] || "(untitled)", body: parts.slice(1).join("\n\n"), isDeleted: false, json: null };
    }
    return { title: content.substring(0, 80), body: content, isDeleted: false, json: null };
  }
}

/**
 * Raised when a stored item is not the Joplin v3 JSON document every tool
 * expects. Display paths read such a row through the lenient
 * `parseJoplinContent`; every path that rebuilds or merges the stored document
 * goes through `parseRawJson` and fails here, instead of writing a fabricated
 * object over the original.
 */
export class MalformedItemContentError extends Error {
  constructor(detail: string) {
    super(`Stored item content is not valid Joplin v3 JSON (${detail}); refusing to operate on it.`);
    this.name = "MalformedItemContentError";
  }
}

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Parse raw item content as JSON, preserving ALL fields (incl. the nested
 * 'icon' string). Throws {@link MalformedItemContentError} on anything else:
 * a write must never rebuild a document it could not read.
 */
export function parseRawJson(raw: Buffer | string | null): Record<string, any> {
  const content = readContent(raw);
  if (!content) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new MalformedItemContentError(error instanceof Error ? error.message : String(error));
  }
  if (!isJsonObject(parsed)) {
    throw new MalformedItemContentError("the top-level value is not a JSON object");
  }
  return parsed;
}

/** Build Joplin v3 JSON content for a new note */
export function buildNoteContent(title: string, body: string, extra: Record<string, any> = {}): Buffer {
  const now = Date.now();
  const data = {
    title,
    body,
    source: "joplin-mcp",
    source_url: "",
    markup_language: 1,
    is_todo: 0,
    deleted_time: 0,
    user_data: "",
    master_key_id: "",
    is_shared: 0,
    encryption_cipher_text: "",
    user_updated_time: now,
    user_created_time: now,
    conflict_original_id: "",
    ...extra,
  };
  return Buffer.from(JSON.stringify(data), "utf-8");
}

/** Build the folder 'icon' field value: a string containing a compact JSON object. */
export function buildIconString(icon: NotebookIcon): string {
  return JSON.stringify({ emoji: icon.emoji || "", name: icon.name || "", type: icon.type ?? 1 });
}

/**
 * Build the Joplin v3 resource item content, mirroring the exact field set used by
 * the desktop client (verified against rows produced by a real sync).
 */
export function buildResourceContent(params: { title: string; mime: string; size: number; now: number }): Buffer {
  const { title, mime, size, now } = params;
  const data = {
    is_locked: 0,
    ocr_driver_id: 1,
    ocr_error: "",
    ocr_status: 0,
    ocr_details: "",
    ocr_text: "",
    blob_updated_time: now,
    user_data: "",
    master_key_id: "",
    is_shared: 0,
    size,
    encryption_blob_encrypted: 0,
    encryption_cipher_text: "",
    file_extension: fileExtensionFromName(title),
    user_updated_time: now,
    user_created_time: now,
    created_time: now,
    filename: "",
    mime,
    title,
  };
  return Buffer.from(JSON.stringify(data), "utf-8");
}

export function buildTagContent(title: string, now: number): Buffer {
  const data = {
    user_data: "",
    is_shared: 0,
    encryption_cipher_text: "",
    user_updated_time: now,
    user_created_time: now,
    created_time: now,
    title,
  };
  return Buffer.from(JSON.stringify(data), "utf-8");
}

/** note <-> tag relation item (jop_type 6), as produced by the desktop client. */
export function buildNoteTagContent(tagJopId: string, noteJopId: string, now: number): Buffer {
  const data = {
    is_shared: 0,
    encryption_cipher_text: "",
    user_updated_time: now,
    user_created_time: now,
    created_time: now,
    tag_id: tagJopId,
    note_id: noteJopId,
  };
  return Buffer.from(JSON.stringify(data), "utf-8");
}
