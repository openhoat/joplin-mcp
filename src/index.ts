#!/usr/bin/env node
/**
 * Joplin MCP Server - Access Joplin notes via PostgreSQL direct access.
 * Uses the official MCP SDK with per-connection server instances.
 * Supports Joplin v3 JSON content format.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import express from "express";
import { Pool } from "pg";
import * as crypto from "crypto";

const DB_HOST = process.env.JOPLIN_DB_HOST || "pgsql";
const DB_PORT = parseInt(process.env.JOPLIN_DB_PORT || "5432");
const DB_NAME = process.env.JOPLIN_DB_NAME || "joplin";
const DB_USER = process.env.JOPLIN_DB_USER || "postgres";
const DB_PASSWORD = process.env.JOPLIN_DB_PASSWORD || "postgres";
const USER_ID = process.env.JOPLIN_USER_ID || "";
const MCP_PORT = parseInt(process.env.MCP_PORT || "8000");
const MCP_API_KEY = process.env.MCP_API_KEY || "";
const MCP_PUBLIC_URL = (process.env.MCP_PUBLIC_URL || "http://localhost:8000").replace(/\/+$/, "");

const JOP_TYPE_NOTE = 1;
const JOP_TYPE_FOLDER = 2;
const JOP_TYPE_RESOURCE = 4;
const JOP_TYPE_TAG = 5;
const JOP_TYPE_NOTE_TAG = 6;
/**
 * Resource file content lives in plain `items` rows: jop_type 0, empty jop_id,
 * mime_type '', an empty jop_updated_time, and a ".resource/<resource jop_id>" name.
 */
const JOP_TYPE_BLOB = 0;
const RESOURCE_BLOB_PREFIX = ".resource/";
/**
 * Server-side note history entries: written by Joplin Server on every item save,
 * never by us. Read-only (`get_note_history`).
 */
const JOP_TYPE_HISTORY = 13;

const DEFAULT_INLINE_DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024;
const HARD_INLINE_DOWNLOAD_MAX_BYTES = 32 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;
const MCP_JSON_LIMIT = "48mb";

const pool = new Pool({
  host: DB_HOST, port: DB_PORT, database: DB_NAME,
  user: DB_USER, password: DB_PASSWORD,
  max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000,
});

async function getUserId(): Promise<string> {
  if (USER_ID) return USER_ID;
  const result = await pool.query("SELECT id FROM users ORDER BY created_time LIMIT 1");
  if (result.rows.length > 0) return result.rows[0].id;
  throw new Error("No user found in Joplin database");
}

function formatTimestamp(tsMs: number | string): string {
  if (!tsMs) return "N/A";
  try {
    // pg returns bigint columns as strings: coerce before building the Date
    const value = typeof tsMs === "string" ? parseInt(tsMs, 10) : tsMs;
    if (!Number.isFinite(value) || value <= 0) return "N/A";
    return new Date(value).toISOString().replace("T", " ").substring(0, 19);
  }
  catch { return String(tsMs); }
}

/**
 * Normalise a todo due date: epoch ms (number or numeric string) or an ISO 8601
 * string. Returns undefined when the caller did not provide a value, 0 when the
 * value must be cleared, NaN when it cannot be parsed.
 */
function parseDueDate(value: string | number | null | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (value === null) return 0;
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  const trimmed = value.trim();
  if (!trimmed) return 0;
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? NaN : parsed;
}

/**
 * Joplin stores note history changes as diff-match-patch hunks, not as text: an array of
 * `{ diffs: [[op, text], ...], start1, length1, start2, length2 }` where op 1 = inserted,
 * -1 = deleted and 0 = unchanged. Keep the changed fragments only, they read like a patch.
 */
function renderHistoryDiff(raw: any, maxChars = 240): string[] {
  if (!raw) return [];
  let hunks = raw;
  if (typeof hunks === "string") {
    try { hunks = JSON.parse(hunks); } catch { return [String(hunks).slice(0, maxChars)]; }
  }
  if (!Array.isArray(hunks)) return [];
  const lines: string[] = [];
  for (const hunk of hunks) {
    const parts = Array.isArray(hunk?.diffs) ? hunk.diffs : [];
    for (const part of parts) {
      const op = Number(Array.isArray(part) ? part[0] : NaN);
      const text = String(Array.isArray(part) ? part[1] ?? "" : "");
      if (!text.trim()) continue;
      const label = op === 1 ? "+" : op === -1 ? "-" : null;
      if (!label) continue;
      const clean = text.replace(/\s+/g, " ").trim();
      lines.push(`${label} ${clean.length > maxChars ? `${clean.slice(0, maxChars)}…` : clean}`);
    }
  }
  return lines;
}

function readContent(raw: Buffer | string | null): string {
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf-8");
  return String(raw);
}

/** Parse Joplin v3 JSON content. Returns { title, body, ...metadata } or falls back to raw content. */
function parseJoplinContent(raw: Buffer | string | null): { title: string; body: string; isDeleted: boolean; json: Record<string, any> | null } {
  const content = readContent(raw);
  if (!content) return { title: "(untitled)", body: "", isDeleted: false, json: null };

  try {
    // Remove problematic "icon" field that contains nested JSON with emojis that breaks JSON.parse
    let cleanContent = content.replace(/"icon"\s*:\s*"\{[^}]*\}"/g, '"icon":""');
    const parsed = JSON.parse(cleanContent);
    return {
      title: parsed.title || "(untitled)",
      body: parsed.body || parsed.markdown || "",
      isDeleted: (parsed.deleted_time && parsed.deleted_time > 0) || (parsed.is_todo === 2),
      json: parsed
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

/** Parse raw item content as JSON, preserving ALL fields (incl. the nested 'icon' string). */
function parseRawJson(raw: Buffer | string | null): Record<string, any> {
  const content = readContent(raw);
  if (!content) return {};
  try {
    return JSON.parse(content) as Record<string, any>;
  } catch {
    // Fallback to the lenient parser if the raw content is not strictly valid JSON
    return parseJoplinContent(raw).json || {};
  }
}

/** Build Joplin v3 JSON content for a new note */
function buildNoteContent(title: string, body: string, extra: Record<string, any> = {}): Buffer {
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
    ...extra
  };
  return Buffer.from(JSON.stringify(data), "utf-8");
}

/**
 * Build the Joplin folder 'icon' field value.
 * In Joplin v3 content, 'icon' is a STRING containing a compact JSON object
 * (e.g. "{\"emoji\":\"🏦\",\"name\":\"bank\",\"type\":1}"), not a nested object.
 */
type NotebookIcon = { emoji?: string; name?: string; type?: number };

function buildIconString(icon: NotebookIcon): string {
  return JSON.stringify({ emoji: icon.emoji || "", name: icon.name || "", type: icon.type ?? 1 });
}

function generateId(): string {
  // Joplin uses 22-char base62 IDs (0-9, a-z, A-Z) for the 'id' field
  // Use 22 random bytes (one per char) to avoid repetitive patterns
  const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const bytes = crypto.randomBytes(22);
  let id = "";
  for (let i = 0; i < 22; i++) {
    id += chars[bytes[i] % 62];
  }
  return id;
}

function generateJopId(): string {
  // Joplin Server v3 uses 32-char UUID hex (no dashes) for the 'jop_id' field
  return crypto.randomUUID().replace(/-/g, "");
}

/** Map jop_type (items table) to item_type (changes table) */
function jopTypeToChangeItemType(jopType: number): number {
  // In items: jop_type 1=note, 2=folder
  // In changes: item_type 2=note, 1=folder (swapped!)
  return jopType === JOP_TYPE_NOTE ? 2 : 1;
}

/** Change type constants for the changes table */
const CHANGE_CREATED = 1;
const CHANGE_UPDATED = 2;
const CHANGE_DELETED = 3;

/**
 * Record an item ownership in user_items table so Joplin Server includes it in sync.
 * Without this, notes created by MCP won't be visible to the user in sync.
 */
async function recordUserItem(params: {
  itemId: string;
  userId: string;
}): Promise<void> {
  const { itemId, userId } = params;
  const now = Date.now();
  // Check if already exists to avoid duplicates
  const existing = await pool.query(`SELECT id FROM user_items WHERE item_id = $1 AND user_id = $2`, [itemId, userId]);
  if (existing.rows.length === 0) {
    await pool.query(
      `INSERT INTO user_items (user_id, item_id, updated_time, created_time)
       VALUES ($1, $2, $3, $3)`,
      [userId, itemId, now]
    );
  }
}

/**
 * Active changes table name, cached after first detection.
 * Since joplin-server 3.7.1 (migration split_changes), the delta sync reads
 * changes_2 instead of the legacy changes table. We detect the target table
 * once at runtime and fall back to changes if changes_2 does not exist.
 */
let activeChangesTable: "changes_2" | "changes" | null = null;

async function getActiveChangesTable(): Promise<"changes_2" | "changes"> {
  if (activeChangesTable) return activeChangesTable;
  const res = await pool.query(`SELECT to_regclass('public.changes_2') AS tbl`);
  activeChangesTable = res.rows[0]?.tbl ? "changes_2" : "changes";
  return activeChangesTable;
}

/**
 * Record a change so Joplin Server notifies clients via sync.
 * Without this, notes created/updated/deleted by MCP won't appear on synced clients.
 */
async function recordChange(params: {
  itemId: string;
  itemType: number;  // jop_type from items (1=note, 2=folder, 4=resource, 5=tag, 6=note_tag, 0=blob)
  changeType: number; // CHANGE_CREATED, CHANGE_UPDATED, CHANGE_DELETED
  jopId: string;
  userId: string;
  /** Optional explicit sync name (blob items use ".resource/<jop_id>" instead of "<jop_id>.md") */
  itemName?: string;
  /** Optional explicit changes.item_type. Real Joplin clients write 2 on creation, 1 on update. */
  changeItemType?: number;
}): Promise<void> {
  const { itemId, itemType, changeType, jopId, userId } = params;
  const changeId = generateId();
  const now = Date.now();
  const itemName = params.itemName ?? `${jopId}.md`;
  const changesItemType = params.changeItemType ?? jopTypeToChangeItemType(itemType);
  const table = await getActiveChangesTable();
  if (table === "changes_2") {
    await pool.query(
      `INSERT INTO changes_2 (id, item_id, user_id, item_name, previous_share_id, item_type, type, updated_time, created_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [changeId, itemId, userId, itemName, "", changesItemType, changeType, now, now]
    );
  } else {
    await pool.query(
      `INSERT INTO changes (id, item_type, item_id, item_name, type, updated_time, created_time, previous_item, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [changeId, changesItemType, itemId, itemName, changeType, now, now, "", userId]
    );
  }
}

/* ====== RESOURCES (attachments) & TAGS ====== */

type JoplinItemRow = {
  id: string;
  name: string;
  content: Buffer | string | null;
  jop_id: string;
  jop_parent_id: string;
  jop_type: number;
  content_size: number;
  updated_time: number;
};

/** Resolve an item by the MCP-facing base62 id OR by the client-facing 32-hex jop_id. */
async function findItem(idOrJopId: string, jopType: number, userId: string): Promise<JoplinItemRow | null> {
  const result = await pool.query(
    `SELECT id, name, content, jop_id, jop_parent_id, jop_type, content_size, updated_time
     FROM items WHERE owner_id = $1 AND jop_type = $2 AND (id = $3 OR jop_id = $3) LIMIT 1`,
    [userId, jopType, idOrJopId]
  );
  return (result.rows[0] as JoplinItemRow) || null;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "0 o";
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

function fileExtensionFromName(name: string): string {
  const match = /\.([A-Za-z0-9]{1,12})$/.exec(name.trim());
  return match ? match[1].toLowerCase() : "";
}

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  html: "text/html",
  json: "application/json",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp4: "video/mp4",
  mp3: "audio/mpeg"
};

function guessMime(filename: string): string {
  return MIME_BY_EXTENSION[fileExtensionFromName(filename)] || "application/octet-stream";
}

/**
 * Build the Joplin v3 resource item content, mirroring the exact field set used by
 * the desktop client (verified against rows produced by a real sync).
 */
function buildResourceContent(params: { title: string; mime: string; size: number; now: number }): Buffer {
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
    title
  };
  return Buffer.from(JSON.stringify(data), "utf-8");
}

function buildTagContent(title: string, now: number): Buffer {
  const data = {
    user_data: "",
    is_shared: 0,
    encryption_cipher_text: "",
    user_updated_time: now,
    user_created_time: now,
    created_time: now,
    title
  };
  return Buffer.from(JSON.stringify(data), "utf-8");
}

/** note <-> tag relation item (jop_type 6), as produced by the desktop client. */
function buildNoteTagContent(tagJopId: string, noteJopId: string, now: number): Buffer {
  const data = {
    is_shared: 0,
    encryption_cipher_text: "",
    user_updated_time: now,
    user_created_time: now,
    created_time: now,
    tag_id: tagJopId,
    note_id: noteJopId
  };
  return Buffer.from(JSON.stringify(data), "utf-8");
}

/** Keep the server-side note->resource index in sync (table derived by Joplin Server on item save). */
async function linkResourceUsage(noteItemId: string, resourceJopId: string): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO item_resources (item_id, resource_id)
       SELECT $1::varchar, $2::varchar WHERE NOT EXISTS (
         SELECT 1 FROM item_resources WHERE item_id = $1::varchar AND resource_id = $2::varchar
       )`,
      [noteItemId, resourceJopId]
    );
  } catch (e: any) {
    console.warn(`item_resources insert skipped: ${e.message}`);
  }
}

async function unlinkResourceUsage(noteItemId: string, resourceJopId: string): Promise<void> {
  try {
    await pool.query(`DELETE FROM item_resources WHERE item_id = $1 AND resource_id = $2`, [noteItemId, resourceJopId]);
  } catch (e: any) {
    console.warn(`item_resources delete skipped: ${e.message}`);
  }
}

function escapeMarkdownLabel(label: string): string {
  return label.replace(/([\[\]\\])/g, "\\$1");
}

function buildResourceLink(label: string, resourceJopId: string, asImage: boolean): string {
  return `${asImage ? "!" : ""}[${escapeMarkdownLabel(label)}](:/${resourceJopId})`;
}

/** Read the blob row holding the resource bytes. */
/**
 * Replace the binary content of an existing resource (metadata item + blob row).
 * The resource id and jop_id are kept, so every `:/` link already written in note
 * bodies keeps resolving — that is the whole point of a replace instead of an
 * add/delete pair. Mirrors the desktop: new bytes in the blob row, `size` and
 * `blob_updated_time` refreshed in the metadata, one update change per row
 * (blob rows use the `.resource/<jop_id>` sync name and item_type 1 on update).
 */
async function replaceResourceContent(params: {
  resource: JoplinItemRow;
  data: Buffer;
  mime?: string;
  filename?: string;
  userId: string;
}): Promise<{ id: string; jopId: string; title: string; mime: string; sizeBefore: number; size: number }> {
  const { resource, data, userId } = params;
  const json = parseRawJson(resource.content);
  const blob = await pool.query(
    `SELECT id FROM items WHERE owner_id = $1 AND name = $2 LIMIT 1`,
    [userId, `${RESOURCE_BLOB_PREFIX}${resource.jop_id}`]
  );
  if (blob.rows.length === 0) throw new Error("binaire introuvable pour cette ressource");
  const now = Date.now();
  const title = String(params.filename || json.title || "").trim() || "fichier";
  const mime = params.mime || (params.filename ? guessMime(params.filename) : String(json.mime || guessMime(title)));
  const meta = {
    ...json,
    title,
    mime,
    file_extension: fileExtensionFromName(title) || String(json.file_extension || ""),
    size: data.length,
    blob_updated_time: now,
    user_updated_time: now
  };
  const metaBytes = Buffer.from(JSON.stringify(meta), "utf-8");
  await pool.query(
    `UPDATE items SET content = $1, content_size = $2, updated_time = $3, jop_updated_time = $3 WHERE id = $4`,
    [metaBytes, metaBytes.length, now, resource.id]
  );
  // Blob rows keep jop_updated_time at 0, like the desktop writes them
  await pool.query(
    `UPDATE items SET content = $1, content_size = $2, updated_time = $3 WHERE id = $4`,
    [data, data.length, now, blob.rows[0].id]
  );
  await recordChange({ itemId: blob.rows[0].id, itemType: JOP_TYPE_BLOB, changeType: CHANGE_UPDATED, jopId: resource.jop_id, userId, itemName: `${RESOURCE_BLOB_PREFIX}${resource.jop_id}`, changeItemType: 1 });
  await recordChange({ itemId: resource.id, itemType: JOP_TYPE_RESOURCE, changeType: CHANGE_UPDATED, jopId: resource.jop_id, userId, changeItemType: 1 });
  return { id: resource.id, jopId: resource.jop_id, title, mime, sizeBefore: Number(json.size || 0), size: data.length };
}

async function findResourceBlob(resourceJopId: string, userId: string): Promise<{ id: string; content: Buffer; content_size: number } | null> {
  const result = await pool.query(
    `SELECT id, content, content_size FROM items WHERE owner_id = $1 AND name = $2 LIMIT 1`,
    [userId, `${RESOURCE_BLOB_PREFIX}${resourceJopId}`]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return { id: row.id, content: Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content || ""), content_size: Number(row.content_size) };
}

/**
 * Create a full resource (metadata item + blob item + ownership + sync changes),
 * exactly like a desktop client upload. Returns the MCP-facing ids.
 */
async function createResource(params: {
  title: string;
  data: Buffer;
  mime?: string;
  userId: string;
}): Promise<{ id: string; jopId: string; title: string; mime: string; size: number }> {
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
    [resourceId, `${jopId}.md`, "text/markdown", now, contentBytes, contentBytes.length, jopId, "", "", JOP_TYPE_RESOURCE, 0, userId, 1]
  );
  await recordUserItem({ itemId: resourceId, userId });
  await recordChange({ itemId: resourceId, itemType: JOP_TYPE_RESOURCE, changeType: CHANGE_CREATED, jopId, userId, changeItemType: 2 });

  await pool.query(
    `INSERT INTO items (id, name, mime_type, updated_time, created_time, content, content_size, jop_id, jop_parent_id, jop_share_id, jop_type, jop_encryption_applied, jop_updated_time, owner_id, content_storage_id)
     VALUES ($1, $2, '', $3, $3, $4, $5, '', '', '', $6, 0, 0, $7, 1)`,
    [blobId, `${RESOURCE_BLOB_PREFIX}${jopId}`, now, data, data.length, JOP_TYPE_BLOB, userId]
  );
  await recordUserItem({ itemId: blobId, userId });
  await recordChange({ itemId: blobId, itemType: JOP_TYPE_BLOB, changeType: CHANGE_CREATED, jopId, userId, itemName: `${RESOURCE_BLOB_PREFIX}${jopId}`, changeItemType: 2 });

  return { id: resourceId, jopId, title, mime, size: data.length };
}

/** Append a markdown resource link to a note body (the desktop derives its own dependencies from it). */
async function appendResourceLinkToNote(note: JoplinItemRow, resourceTitle: string, resourceJopId: string, asImage: boolean): Promise<void> {
  const parsed = parseJoplinContent(note.content);
  const extra: Record<string, any> = {};
  if (parsed.json) {
    for (const [k, v] of Object.entries(parsed.json)) {
      if (!["title", "body", "source", "source_url"].includes(k)) extra[k] = v;
    }
  }
  const now = Date.now();
  const trimmed = parsed.body.replace(/\s+$/, "");
  const link = buildResourceLink(resourceTitle, resourceJopId, asImage);
  const newBody = `${trimmed}${trimmed ? "\n" : ""}${link}\n`;
  const contentBytes = buildNoteContent(parsed.title, newBody, { ...extra, user_updated_time: now });
  await pool.query(
    `UPDATE items SET content = $1, content_size = $2, updated_time = $3, jop_updated_time = $3 WHERE id = $4`,
    [contentBytes, contentBytes.length, now, note.id]
  );
  const userId = await getUserId();
  await recordChange({ itemId: note.id, itemType: JOP_TYPE_NOTE, changeType: CHANGE_UPDATED, jopId: note.jop_id, userId, changeItemType: 1 });
  await linkResourceUsage(note.id, resourceJopId);
}

/** Remove every markdown link pointing at the resource from a note body. Returns the removed count. */
async function removeResourceLinksFromNote(note: JoplinItemRow, resourceJopId: string): Promise<number> {
  const parsed = parseJoplinContent(note.content);
  const pattern = new RegExp(`!?\\[[^\\]]*\\]\\(:/${resourceJopId}\\)`, "g");
  const occurrences = (parsed.body.match(pattern) || []).length;
  await unlinkResourceUsage(note.id, resourceJopId);
  if (occurrences === 0) return 0;

  const extra: Record<string, any> = {};
  if (parsed.json) {
    for (const [k, v] of Object.entries(parsed.json)) {
      if (!["title", "body", "source", "source_url"].includes(k)) extra[k] = v;
    }
  }
  const now = Date.now();
  const newBody = parsed.body.replace(pattern, "").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
  const contentBytes = buildNoteContent(parsed.title, newBody, { ...extra, user_updated_time: now });
  await pool.query(
    `UPDATE items SET content = $1, content_size = $2, updated_time = $3, jop_updated_time = $3 WHERE id = $4`,
    [contentBytes, contentBytes.length, now, note.id]
  );
  const userId = await getUserId();
  await recordChange({ itemId: note.id, itemType: JOP_TYPE_NOTE, changeType: CHANGE_UPDATED, jopId: note.jop_id, userId, changeItemType: 1 });
  return occurrences;
}

/** Resource ids referenced by a note: indexed table first, note body as a fallback. */
async function listNoteResourceIds(note: JoplinItemRow): Promise<string[]> {
  const indexed = await pool.query(`SELECT resource_id FROM item_resources WHERE item_id = $1`, [note.id]);
  const ids = new Set<string>(indexed.rows.map((r: any) => String(r.resource_id)));
  const body = parseJoplinContent(note.content).body;
  const pattern = /\(:\/([0-9a-f]{32})\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) ids.add(match[1]);
  return Array.from(ids);
}

function resourceSummary(row: JoplinItemRow): { id: string; jopId: string; title: string; mime: string; size: number; updated: string; fileExtension: string; isDeleted: boolean } {
  const json = parseRawJson(row.content);
  const title = String(json.title || "(sans titre)");
  return {
    id: row.id,
    jopId: row.jop_id,
    title,
    mime: String(json.mime || guessMime(title)),
    size: Number(json.size || 0),
    updated: formatTimestamp(Number(row.updated_time)),
    fileExtension: String(json.file_extension || fileExtensionFromName(title)),
    isDeleted: Number(json.deleted_time || 0) > 0
  };
}

function createMcpServer(): McpServer {
  const server = new McpServer({ name: "joplin", version: "1.6.1" });

  // ====== SEARCH / READ TOOLS ======

  server.tool("search_notes", "Search notes by title or body content. Returns note IDs with SHORT PREVIEWS only. WORKFLOW: 1) Call this to find notes. 2) Then call `get_note` with the note_id to read the FULL content. NEVER answer questions about note content based only on the preview - always call `get_note` first.",
    {
      query: z.string().describe("The search text"),
      notebook_id: z.string().optional().describe("Optional notebook ID to filter search within"),
      limit: z.number().default(10).describe("Max results")
    },
    async ({ query, notebook_id, limit }) => {
      try {
        const userId = await getUserId();
        const conditions = [`i.owner_id = $1`, `i.jop_type = $2`, `encode(i.content, 'escape') ILIKE $3`];
        const params: any[] = [userId, JOP_TYPE_NOTE, `%${query}%`];
        let paramIdx = 4;
        if (notebook_id) {
          // notebook_id is base62 'id' - need to look up the jop_id (UUID hex) for jop_parent_id comparison
          const folderLookup = await pool.query(`SELECT jop_id FROM items WHERE id = $1 AND jop_type = $2`, [notebook_id, JOP_TYPE_FOLDER]);
          if (folderLookup.rows.length > 0) {
            conditions.push(`i.jop_parent_id = $${paramIdx}`);
            params.push(folderLookup.rows[0].jop_id);
          } else {
            conditions.push(`i.jop_parent_id = $${paramIdx}`);
            params.push(notebook_id);
          }
          paramIdx++;
        }
        params.push(Math.min(limit, 50));
        const result = await pool.query(
          `SELECT i.id, i.content, i.updated_time FROM items i
           WHERE ${conditions.join(" AND ")}
           ORDER BY i.updated_time DESC LIMIT $${paramIdx}`,
          params
        );
        if (result.rows.length === 0) return { content: [{ type: "text" as const, text: `Aucune note trouvée pour '${query}'.` }] };
        const notes = result.rows.map((row: any) => {
          const parsed = parseJoplinContent(row.content);
          const isTruncated = parsed.body.length > 200;
          return { id: row.id, title: parsed.title, preview: isTruncated ? parsed.body.substring(0, 200) : parsed.body, isTruncated, isDeleted: parsed.isDeleted, updated: formatTimestamp(row.updated_time) };
        }).filter((n: any) => !n.isDeleted);
        if (notes.length === 0) return { content: [{ type: "text" as const, text: `Aucune note trouvée pour '${query}'.` }] };
        const lines = notes.map((n: any) => `📝 **${n.title}** (ID: ${n.id})\n   Mis à jour: ${n.updated}\n   Aperçu: ${n.preview}${n.isTruncated ? "\n   ⚠️ CONTENU TRONQUÉ - Utilise get_note avec cet ID pour lire la note en entier" : ""}`);
        return { content: [{ type: "text" as const, text: `Trouvé ${notes.length} note(s) pour '${query}':\n\n${lines.join("\n\n")}` }] };
      } catch (e: any) { return { content: [{ type: "text" as const, text: `Erreur: ${e.message}` }] }; }
    }
  );

  server.tool("get_note", "Read the FULL content of a specific Joplin note. ALWAYS call this before answering questions about a note's content. Use after `search_notes` or `get_recent_notes` to get the complete text from a note_id. This returns the entire note body without truncation.",
    { note_id: z.string().describe("The ID of the note") },
    async ({ note_id }) => {
      try {
        const result = await pool.query(
          `SELECT i.id, i.content, i.updated_time, i.jop_parent_id FROM items i WHERE i.id = $1 AND i.jop_type = $2`,
          [note_id, JOP_TYPE_NOTE]
        );
        if (result.rows.length === 0) return { content: [{ type: "text" as const, text: `Note '${note_id}' non trouvée.` }] };
        const row: any = result.rows[0];
        const parsed = parseJoplinContent(row.content);
        if (parsed.isDeleted) return { content: [{ type: "text" as const, text: `Note '${note_id}' est dans la corbeille.` }] };
        let notebookName = "";
        if (row.jop_parent_id) {
          // jop_parent_id stores the jop_id (UUID hex), look up by jop_id
          const fr = await pool.query(`SELECT content FROM items WHERE jop_id = $1 AND jop_type = $2`, [row.jop_parent_id, JOP_TYPE_FOLDER]);
          if (fr.rows.length > 0) {
            const folderParsed = parseJoplinContent(fr.rows[0].content);
            notebookName = folderParsed.title;
          }
        }
        let text = `📝 **${parsed.title}**\n`;
        if (notebookName) text += `📂 Carnet: ${notebookName}\n`;
        text += `🕐 Mis à jour: ${formatTimestamp(row.updated_time)}\n🆔 ID: ${row.id}\n\n--- Contenu ---\n\n${parsed.body}`;
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) { return { content: [{ type: "text" as const, text: `Erreur: ${e.message}` }] }; }
    }
  );

  server.tool("get_recent_notes", "Get the most recently updated notes. Returns note IDs with SHORT PREVIEWS only. WORKFLOW: 1) Call this to find recent notes. 2) Then call `get_note` with the note_id to read the FULL content. NEVER answer questions about note content based only on the preview.",
    {
      limit: z.number().default(10).describe("Max notes"),
      notebook_id: z.string().optional().describe("Optional notebook ID to filter")
    },
    async ({ limit, notebook_id }) => {
      try {
        const userId = await getUserId();
        let query: string;
        let params: any[];
        if (notebook_id) {
          // notebook_id is base62 'id' - need to look up jop_id for jop_parent_id comparison
          const folderLookup = await pool.query(`SELECT jop_id FROM items WHERE id = $1 AND jop_type = $2`, [notebook_id, JOP_TYPE_FOLDER]);
          const parentJopId = folderLookup.rows.length > 0 ? folderLookup.rows[0].jop_id : notebook_id;
          query = `SELECT i.id, i.content, i.updated_time FROM items i
                   WHERE i.owner_id = $1 AND i.jop_type = $2 AND i.jop_parent_id = $3 ORDER BY i.updated_time DESC LIMIT $4`;
          params = [userId, JOP_TYPE_NOTE, parentJopId, Math.min(limit, 50)];
        } else {
          query = `SELECT i.id, i.content, i.updated_time FROM items i
                   WHERE i.owner_id = $1 AND i.jop_type = $2 ORDER BY i.updated_time DESC LIMIT $3`;
          params = [userId, JOP_TYPE_NOTE, Math.min(limit, 50)];
        }
        const result = await pool.query(query, params);
        if (result.rows.length === 0) return { content: [{ type: "text" as const, text: "Aucune note trouvée." }] };
        const notes = result.rows.map((row: any) => {
          const parsed = parseJoplinContent(row.content);
          const isTruncated = parsed.body.length > 100;
          return { id: row.id, title: parsed.title, preview: isTruncated ? parsed.body.substring(0, 100) : parsed.body, isTruncated, isDeleted: parsed.isDeleted, updated: formatTimestamp(row.updated_time) };
        }).filter((n: any) => !n.isDeleted);
        if (notes.length === 0) return { content: [{ type: "text" as const, text: "Aucune note trouvée." }] };
        const lines = notes.map((n: any) => `📝 **${n.title}** (ID: ${n.id})\n   ${n.updated} - ${n.preview}${n.isTruncated ? "\n   ⚠️ CONTENU TRONQUÉ - Utilise get_note avec cet ID pour lire la note en entier" : ""}`);
        return { content: [{ type: "text" as const, text: `📝 Notes récentes (${notes.length}):\n\n${lines.join("\n\n")}` }] };
      } catch (e: any) { return { content: [{ type: "text" as const, text: `Erreur: ${e.message}` }] }; }
    }
  );

  server.tool("search_notebooks", "Search for notebooks by name. Returns notebook IDs. WORKFLOW: Use the returned notebook_id with `list_notes_in_notebook` to see its notes, or with `create_note` to create a note inside it.",
    {
      query: z.string().describe("The search text to find in notebook titles"),
      limit: z.number().default(10).describe("Max results")
    },
    async ({ query, limit }) => {
      try {
        const userId = await getUserId();
        const result = await pool.query(
          `SELECT i.id, i.content, i.updated_time FROM items i
           WHERE i.owner_id = $1 AND i.jop_type = $2 AND encode(i.content, 'escape') ILIKE $3
           ORDER BY i.updated_time DESC LIMIT $4`,
          [userId, JOP_TYPE_FOLDER, `%${query}%`, Math.min(limit, 50)]
        );
        if (result.rows.length === 0) return { content: [{ type: "text" as const, text: `Aucun carnet trouvé pour '${query}'.` }] };
        const notebooks = result.rows.map((row: any) => {
          const parsed = parseJoplinContent(row.content);
          return `📂 **${parsed.title}** (ID: ${row.id})`;
        });
        return { content: [{ type: "text" as const, text: `Trouvé ${notebooks.length} carnet(s) pour '${query}':\n\n${notebooks.join("\n")}` }] };
      } catch (e: any) { return { content: [{ type: "text" as const, text: `Erreur: ${e.message}` }] }; }
    }
  );

  server.tool("list_notebooks", "List all notebooks. Returns notebook IDs. WORKFLOW: Use `list_notes_in_notebook` with a notebook_id to see the notes inside, or use the notebook_id with `create_note` to place a new note in it.", {},
    async () => {
      try {
        const userId = await getUserId();
        const result = await pool.query(
          `SELECT i.id, i.content, i.updated_time FROM items i
           WHERE i.owner_id = $1 AND i.jop_type = $2 ORDER BY i.updated_time DESC`,
          [userId, JOP_TYPE_FOLDER]
        );
        if (result.rows.length === 0) return { content: [{ type: "text" as const, text: "Aucun carnet trouvé." }] };
        const notebooks = result.rows.map((row: any) => {
          const parsed = parseJoplinContent(row.content);
          return `📂 **${parsed.title}** (ID: ${row.id})`;
        });
        return { content: [{ type: "text" as const, text: `📂 Carnets (${result.rows.length}):\n\n${notebooks.join("\n")}` }] };
      } catch (e: any) { return { content: [{ type: "text" as const, text: `Erreur: ${e.message}` }] }; }
    }
  );

  server.tool("list_notes_in_notebook", "List notes inside a specific notebook. Returns note IDs with SHORT PREVIEWS only. WORKFLOW: 1) Call this to list notes in a notebook. 2) Then call `get_note` with a note_id to read the FULL content. NEVER answer based only on the preview.",
    {
      notebook_id: z.string().describe("The ID of the notebook/folder"),
      limit: z.number().default(20).describe("Max notes to return")
    },
    async ({ notebook_id, limit }) => {
      try {
        // First get the notebook name
        const folderResult = await pool.query(
          `SELECT content FROM items WHERE id = $1 AND jop_type = $2`,
          [notebook_id, JOP_TYPE_FOLDER]
        );
        if (folderResult.rows.length === 0) return { content: [{ type: "text" as const, text: `Carnet '${notebook_id}' non trouvé. Utilise list_notebooks pour voir les carnets disponibles.` }] };
        const folderParsed = parseJoplinContent(folderResult.rows[0].content);

        // notebook_id is base62 'id' - need to look up jop_id for jop_parent_id comparison
        const parentLookup = await pool.query(`SELECT jop_id FROM items WHERE id = $1 AND jop_type = $2`, [notebook_id, JOP_TYPE_FOLDER]);
        const parentJopId = parentLookup.rows.length > 0 ? parentLookup.rows[0].jop_id : notebook_id;
        const result = await pool.query(
          `SELECT i.id, i.content, i.updated_time FROM items i
           WHERE i.jop_parent_id = $1 AND i.jop_type = $2
           ORDER BY i.updated_time DESC LIMIT $3`,
          [parentJopId, JOP_TYPE_NOTE, Math.min(limit, 50)]
        );
        if (result.rows.length === 0) return { content: [{ type: "text" as const, text: `Le carnet "${folderParsed.title}" ne contient aucune note.` }] };
        const notes = result.rows.map((row: any) => {
          const parsed = parseJoplinContent(row.content);
          const isTruncated = parsed.body.length > 100;
          return { id: row.id, title: parsed.title, preview: isTruncated ? parsed.body.substring(0, 100) : parsed.body, isTruncated, isDeleted: parsed.isDeleted, updated: formatTimestamp(row.updated_time) };
        }).filter((n: any) => !n.isDeleted);
        if (notes.length === 0) return { content: [{ type: "text" as const, text: `Le carnet "${folderParsed.title}" ne contient aucune note.` }] };
        const lines = notes.map((n: any) => `📝 **${n.title}** (ID: ${n.id})\n   ${n.updated} - ${n.preview}${n.isTruncated ? "\n   ⚠️ CONTENU TRONQUÉ - Utilise get_note avec cet ID pour lire la note en entier" : ""}`);
        return { content: [{ type: "text" as const, text: `📂 Carnet "${folderParsed.title}" - ${notes.length} note(s):\n\n${lines.join("\n\n")}` }] };
      } catch (e: any) { return { content: [{ type: "text" as const, text: `Erreur: ${e.message}` }] }; }
    }
  );

  server.tool("list_todos", "List the todos (notes carrying a checkbox): open ones, completed ones or both, optionally scoped to a notebook, sorted by due date. In Joplin a reminder is a todo with a `todo_due` date — there is no separate alarm item.",
    {
      status: z.enum(["open", "done", "all"]).default("open").describe("Which todos to list: not completed, completed, or both"),
      notebook_id: z.string().optional().describe("Restrict the listing to one notebook"),
      limit: z.number().default(50).describe("Max todos to return")
    },
    async ({ status, notebook_id, limit }) => {
      try {
        const userId = await getUserId();
        let parentJopId: string | undefined;
        if (notebook_id) {
          const nb = await findItem(notebook_id, JOP_TYPE_FOLDER, userId);
          if (!nb) return { content: [{ type: "text" as const, text: `Carnet '${notebook_id}' non trouvé.` }] };
          parentJopId = nb.jop_id;
        }
        const notes = await pool.query(
          `SELECT id, content, jop_id, jop_parent_id, updated_time FROM items WHERE owner_id = $1 AND jop_type = $2`,
          [userId, JOP_TYPE_NOTE]
        );
        const folders = await pool.query(`SELECT jop_id, content FROM items WHERE owner_id = $1 AND jop_type = $2`, [userId, JOP_TYPE_FOLDER]);
        const folderTitles = new Map<string, string>();
        for (const f of folders.rows as JoplinItemRow[]) folderTitles.set(String(f.jop_id), parseJoplinContent(f.content).title);
        const todos = (notes.rows as JoplinItemRow[])
          .map((row) => {
            const json = parseRawJson(row.content);
            return {
              id: row.id,
              title: String(json.title || "(sans titre)"),
              isTodo: Number(json.is_todo || 0) === 1,
              deleted: Number(json.deleted_time || 0) > 0,
              due: Number(json.todo_due || 0),
              completed: Number(json.todo_completed || 0),
              parent: String(row.jop_parent_id),
              notebook: folderTitles.get(String(row.jop_parent_id)) || "",
              updated: Number(row.updated_time)
            };
          })
          .filter((t) => t.isTodo && !t.deleted && (!parentJopId || t.parent === parentJopId))
          .filter((t) => (status === "all" ? true : status === "open" ? t.completed === 0 : t.completed > 0));
        todos.sort((a, b) => {
          if (status === "done") return b.completed - a.completed;
          if (a.completed !== b.completed) return a.completed - b.completed;
          if (a.due === 0 && b.due > 0) return 1;
          if (b.due === 0 && a.due > 0) return -1;
          return a.due - b.due || a.title.localeCompare(b.title);
        });
        const shown = todos.slice(0, Math.min(limit, 200));
        if (shown.length === 0) {
          const empty = status === "open" ? "Aucun todo à faire." : status === "done" ? "Aucun todo terminé." : "Aucun todo trouvé.";
          return { content: [{ type: "text" as const, text: empty }] };
        }
        const lines = shown.map((t) => {
          const parts = [t.due > 0 ? `échéance ${formatTimestamp(t.due)}` : "", t.completed > 0 ? `fait le ${formatTimestamp(t.completed)}` : ""].filter(Boolean);
          return `${t.completed > 0 ? "☑️" : "☐"} **${t.title}**${parts.length ? ` · ${parts.join(" · ")}` : ""}\n   ID: ${t.id}${t.notebook ? ` · carnet: ${t.notebook}` : ""}`;
        });
        const header = status === "done" ? "faits" : status === "open" ? "à faire" : "tous";
        return { content: [{ type: "text" as const, text: `☑️ Todos (${todos.length} ${header}, ${shown.length} affichés):\n\n${lines.join("\n")}` }] };
      } catch (e: any) { return { content: [{ type: "text" as const, text: `Erreur: ${e.message}` }] }; }
    }
  );

  server.tool("get_notebook_tree", "Show the notebook hierarchy as an indented tree, with a note count per notebook. `list_notebooks` returns a flat list, which hides the parent links — use this one before creating or moving a notebook when nesting matters.",
    {},
    async () => {
      try {
        const userId = await getUserId();
        const folders = await pool.query(
          `SELECT id, jop_id, jop_parent_id, content FROM items WHERE owner_id = $1 AND jop_type = $2`,
          [userId, JOP_TYPE_FOLDER]
        );
        const notes = await pool.query(`SELECT content, jop_parent_id FROM items WHERE owner_id = $1 AND jop_type = $2`, [userId, JOP_TYPE_NOTE]);
        const counts = new Map<string, number>();
        for (const row of notes.rows as JoplinItemRow[]) {
          if (parseJoplinContent(row.content).isDeleted) continue;
          const parent = String(row.jop_parent_id || "");
          counts.set(parent, (counts.get(parent) || 0) + 1);
        }
        const nodes = (folders.rows as JoplinItemRow[])
          .map((row) => {
            const parsed = parseJoplinContent(row.content);
            return { id: row.id, jopId: String(row.jop_id), parent: String(row.jop_parent_id || ""), title: parsed.title, deleted: parsed.isDeleted };
          })
          .filter((n) => !n.deleted);
        if (nodes.length === 0) return { content: [{ type: "text" as const, text: "Aucun carnet." }] };
        const byJop = new Map(nodes.map((n) => [n.jopId, n]));
        const children = new Map<string, typeof nodes>();
        const roots: typeof nodes = [];
        for (const node of nodes) {
          const parent = node.parent && byJop.has(node.parent) ? node.parent : "";
          if (!parent) { roots.push(node); continue; }
          const bucket = children.get(parent) || [];
          bucket.push(node);
          children.set(parent, bucket);
        }
        const lines: string[] = [];
        const walk = (list: typeof nodes, depth: number) => {
          for (const node of [...list].sort((a, b) => a.title.localeCompare(b.title))) {
            const count = counts.get(node.jopId) || 0;
            const branch = depth === 0 ? "📂" : `${"   ".repeat(depth - 1)}└─`;
            lines.push(`${branch} ${node.title} · ${count} note(s) · ID: ${node.id}`);
            walk(children.get(node.jopId) || [], depth + 1);
          }
        };
        walk(roots, 0);
        return { content: [{ type: "text" as const, text: `🌳 Carnets (${nodes.length}):\n\n${lines.join("\n")}` }] };
      } catch (e: any) { return { content: [{ type: "text" as const, text: `Erreur: ${e.message}` }] }; }
    }
  );

  server.tool("list_conflicted_notes", "List the notes Joplin flagged as sync conflicts (`is_conflict`), most recently updated first. Useful to triage what a sync clash left behind; resolve by merging the bodies with `update_note`.",
    { limit: z.number().default(20).describe("Max notes to return") },
    async ({ limit }) => {
      try {
        const userId = await getUserId();
        const rows = await pool.query(
          `SELECT id, content, jop_parent_id, updated_time FROM items
           WHERE owner_id = $1 AND jop_type = $2
             AND encode(content, 'escape') ~ '"is_conflict"[[:space:]]*:[[:space:]]*1'
           ORDER BY updated_time DESC LIMIT $3`,
          [userId, JOP_TYPE_NOTE, Math.min(limit, 200)]
        );
        const folders = await pool.query(`SELECT jop_id, content FROM items WHERE owner_id = $1 AND jop_type = $2`, [userId, JOP_TYPE_FOLDER]);
        const folderTitles = new Map<string, string>();
        for (const f of folders.rows as JoplinItemRow[]) folderTitles.set(String(f.jop_id), parseJoplinContent(f.content).title);
        const notes = (rows.rows as JoplinItemRow[])
          .map((row) => {
            const parsed = parseJoplinContent(row.content);
            const json = parsed.json || {};
            return {
              id: row.id,
              title: parsed.title,
              deleted: parsed.isDeleted,
              originalId: String(json.conflict_original_id || ""),
              notebook: folderTitles.get(String(row.jop_parent_id)) || "",
              updated: Number(row.updated_time)
            };
          })
          .filter((n) => !n.deleted);
        if (notes.length === 0) return { content: [{ type: "text" as const, text: "Aucune note en conflit." }] };
        const lines = notes.map((n) =>
          `⚠️ **${n.title}**\n   ID: ${n.id}${n.notebook ? ` · carnet: ${n.notebook}` : ""} · maj ${formatTimestamp(n.updated)}${n.originalId ? ` · original: ${n.originalId}` : ""}`
        );
        return { content: [{ type: "text" as const, text: `⚠️ Notes en conflit (${notes.length}):\n\n${lines.join("\n\n")}` }] };
      } catch (e: any) { return { content: [{ type: "text" as const, text: `Erreur: ${e.message}` }] }; }
    }
  );

  server.tool("get_note_history", "Read the server-side note history: every recorded change entry for a note (when, which metadata fields changed, title and body edits). Read-only — to roll back, take the text from an entry and call `update_note`.",
    {
      note_id: z.string().describe("The ID of the note (MCP id or Joplin 32-hex id)"),
      limit: z.number().default(10).describe("Max history entries, most recent first")
    },
    async ({ note_id, limit }) => {
      try {
        const userId = await getUserId();
        const note = await findItem(note_id, JOP_TYPE_NOTE, userId);
        if (!note) return { content: [{ type: "text" as const, text: `Note '${note_id}' non trouvée.` }] };
        const rows = await pool.query(
          `SELECT id, content, updated_time FROM items
           WHERE owner_id = $1 AND jop_type = $2 AND encode(content, 'escape') LIKE $3`,
          [userId, JOP_TYPE_HISTORY, `%"item_id":"${note.jop_id}"%`]
        );
        const entries = rows.rows
          .map((row: any) => {
            const json = parseRawJson(row.content);
            return {
              at: Number(json.item_updated_time || row.updated_time),
              metadata: json.metadata_diff,
              title: json.title_diff,
              body: json.body_diff
            };
          })
          .filter((entry: any) => Number(entry.at) > 0)
          .sort((a: any, b: any) => b.at - a.at)
          .slice(0, Math.min(limit, 100));
        if (entries.length === 0) {
          return { content: [{ type: "text" as const, text: `Aucun historique serveur pour « ${parseJoplinContent(note.content).title} ».` }] };
        }
        const blocks = entries.map((entry: any) => {
          const lines: string[] = [`🕘 ${formatTimestamp(entry.at)}`];
          // metadata_diff is stored as a JSON string, the two other diffs as JSON arrays
          let meta: any = entry.metadata;
          if (typeof meta === "string") {
            try { meta = JSON.parse(meta); } catch { meta = null; }
          }
          if (meta && typeof meta === "object") {
            const added = meta.new && typeof meta.new === "object" ? meta.new : {};
            const trashed = Number(added.deleted_time || 0) > 0;
            const changed = Object.keys(added).filter((k) => !["user_created_time", "deleted_time"].includes(k));
            const removed = Array.isArray(meta.deleted) ? meta.deleted : [];
            if (trashed) lines.push("   🗑️ mise à la corbeille");
            if (changed.length) lines.push(`   champs: ${changed.join(", ")}`);
            if (removed.length) lines.push(`   supprimés: ${removed.join(", ")}`);
          }
          const titleDiff = renderHistoryDiff(entry.title);
          if (titleDiff.length) lines.push(`   titre: ${titleDiff.slice(0, 3).join(" | ")}`);
          const bodyDiff = renderHistoryDiff(entry.body);
          if (bodyDiff.length) lines.push(`   corps:\n${bodyDiff.slice(0, 6).map((l: string) => `     ${l}`).join("\n")}`);
          return lines.join("\n");
        });
        return {
          content: [{
            type: "text" as const,
            text: `🕘 Historique de « ${parseJoplinContent(note.content).title} » (${entries.length} entrées):\n\n${blocks.join("\n\n")}`
          }]
        };
      } catch (e: any) { return { content: [{ type: "text" as const, text: `Erreur: ${e.message}` }] }; }
    }
  );

  // ====== WRITE TOOLS ======

  server.tool("create_note", "Create a new note in Joplin. IMPORTANT: You MUST call this function to create a note. NEVER tell the user a note has been created without actually calling this function and receiving a success response. Use `search_notebooks` or `list_notebooks` first to find the notebook_id if the user specifies a notebook.",
    {
      title: z.string().describe("Note title"),
      body: z.string().describe("Note body in Markdown"),
      notebook_id: z.string().optional().describe("Optional notebook ID to place the note in"),
      is_todo: z.boolean().optional().describe("Create a todo (checklist) instead of a plain note"),
      todo_due: z.union([z.string(), z.number(), z.null()]).optional().describe("Due date for a todo: ISO 8601 string (`2026-11-03`, `2026-11-03T09:00`) or epoch milliseconds. null clears it"),
      todo_completed: z.boolean().optional().describe("Mark the todo as completed right away (uses the current time)")
    },
    async ({ title, body, notebook_id, is_todo, todo_due, todo_completed }) => {
      try {
        const userId = await getUserId();
        const noteId = generateId();
        const now = Date.now();
        const jopId = generateJopId();
        const todoExtra: Record<string, any> = {};
        if (is_todo !== undefined) todoExtra.is_todo = is_todo ? 1 : 0;
        if (todo_due !== undefined) {
          const due = parseDueDate(todo_due);
          if (due === null || Number.isNaN(due)) return { content: [{ type: "text" as const, text: `Erreur: échéance '${todo_due}' illisible (ISO 8601 ou epoch ms attendu).` }] };
          todoExtra.todo_due = due;
          if (due > 0 && todoExtra.is_todo === undefined) todoExtra.is_todo = 1;
        }
        if (todo_completed) {
          todoExtra.todo_completed = now;
          todoExtra.is_todo = 1;
        }
        const contentBytes = buildNoteContent(title, body, todoExtra);
        let parentJopId = "";
        if (notebook_id) {
          // notebook_id is the base62 'id' - look up the corresponding 'jop_id' (UUID hex)
          const fr = await pool.query(`SELECT jop_id FROM items WHERE id = $1 AND jop_type = $2`, [notebook_id, JOP_TYPE_FOLDER]);
          if (fr.rows.length > 0) parentJopId = fr.rows[0].jop_id;
        }
        if (!parentJopId) {
          // Fallback: use the first available notebook
          const fr = await pool.query(`SELECT jop_id FROM items WHERE owner_id = $1 AND jop_type = $2 ORDER BY updated_time DESC LIMIT 1`, [userId, JOP_TYPE_FOLDER]);
          if (fr.rows.length > 0) parentJopId = fr.rows[0].jop_id;
        }
        await pool.query(
          `INSERT INTO items (id, name, mime_type, updated_time, created_time, content, content_size, jop_id, jop_parent_id, jop_share_id, jop_type, jop_encryption_applied, jop_updated_time, owner_id, content_storage_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [noteId, `${jopId}.md`, "text/markdown", now, now, contentBytes, contentBytes.length, jopId, parentJopId || "", "", JOP_TYPE_NOTE, 0, now, userId, 1]
        );
        // Record item ownership so Joplin Server includes it in sync
        await recordUserItem({ itemId: noteId, userId });
        // Record change so Joplin Server pushes it to synced clients
        await recordChange({ itemId: noteId, itemType: JOP_TYPE_NOTE, changeType: CHANGE_CREATED, jopId, userId });
        return { content: [{ type: "text" as const, text: `✅ Note créée !\n📝 Titre: ${title}\n🆔 ID: ${noteId}\n📂 Carnet: ${parentJopId || "défaut"}` }] };
      } catch (e: any) { return { content: [{ type: "text" as const, text: `Erreur: ${e.message}` }] }; }
    }
  );

  server.tool("update_note", "Update an existing note's title and/or body content. IMPORTANT: You MUST call this function to update a note. NEVER tell the user a note has been updated without actually calling this function and receiving a success response. WORKFLOW: 1) Use `search_notes` or `get_note` to find the note_id. 2) Call `update_note` with that note_id and the new content. The note_id is REQUIRED and must come from a previous search.",
    {
      note_id: z.string().describe("REQUIRED: The ID of the note to update (from search_notes or get_note)"),
      title: z.string().optional().describe("New title (optional, keeps existing if not provided)"),
      body: z.string().optional().describe("New body content in Markdown (optional, keeps existing if not provided)"),
      is_todo: z.boolean().optional().describe("Turn the note into a todo (true) or back into a plain note (false)"),
      todo_due: z.union([z.string(), z.number(), z.null()]).optional().describe("Due date: ISO 8601 string or epoch milliseconds; null clears it"),
      todo_completed: z.boolean().optional().describe("true marks the todo done now, false reopens it")
    },
    async ({ note_id, title, body, is_todo, todo_due, todo_completed }) => {
      try {
        const hasTodoChange = is_todo !== undefined || todo_due !== undefined || todo_completed !== undefined;
        if (!title && !body && !hasTodoChange) return { content: [{ type: "text" as const, text: "Erreur: fournis au moins un titre, un contenu ou un champ de todo à modifier." }] };
        const result = await pool.query(
          `SELECT i.id, i.content, i.jop_parent_id FROM items i WHERE i.id = $1 AND i.jop_type = $2`,
          [note_id, JOP_TYPE_NOTE]
        );
        if (result.rows.length === 0) return { content: [{ type: "text" as const, text: `Note '${note_id}' non trouvée.` }] };
        const row: any = result.rows[0];
        const parsed = parseJoplinContent(row.content);
        const newTitle = title || parsed.title;
        const newBody = body !== undefined ? body : parsed.body;
        const now = Date.now();
        // Preserve existing metadata from parsed JSON
        const extra: Record<string, any> = {};
        if (parsed.json) {
          for (const [k, v] of Object.entries(parsed.json)) {
            if (!["title", "body", "source", "source_url"].includes(k)) extra[k] = v;
          }
        }
        // Todo fields: Joplin stores them in the note body JSON (is_todo 1/0, todo_due / todo_completed as epoch ms)
        if (is_todo === false) {
          extra.is_todo = 0;
          extra.todo_due = 0;
          extra.todo_completed = 0;
        } else if (is_todo === true) {
          extra.is_todo = 1;
        }
        if (todo_due !== undefined) {
          const due = parseDueDate(todo_due);
          if (due === undefined || Number.isNaN(due)) return { content: [{ type: "text" as const, text: `Erreur: échéance '${todo_due}' illisible (ISO 8601 ou epoch ms attendu).` }] };
          extra.todo_due = due;
          if (due > 0 && extra.is_todo === undefined) extra.is_todo = 1;
        }
        if (todo_completed !== undefined) {
          extra.todo_completed = todo_completed ? now : 0;
          if (todo_completed) extra.is_todo = 1;
          else if (extra.is_todo === undefined) extra.is_todo = 1;
        }
        const contentBytes = buildNoteContent(newTitle, newBody, { ...extra, user_updated_time: now });
        await pool.query(
          `UPDATE items SET content = $1, content_size = $2, updated_time = $3, jop_updated_time = $4 WHERE id = $5`,
          [contentBytes, contentBytes.length, now, now, note_id]
        );
        // Record change so Joplin Server pushes the update to synced clients
        const userId = await getUserId();
        const jopIdResult = await pool.query(`SELECT jop_id FROM items WHERE id = $1`, [note_id]);
        const jopId = jopIdResult.rows.length > 0 ? jopIdResult.rows[0].jop_id : note_id;
        await recordChange({ itemId: note_id, itemType: JOP_TYPE_NOTE, changeType: CHANGE_UPDATED, jopId: jopId, userId, changeItemType: 1 });
        const todoLine = (() => {
          if (!hasTodoChange) return "";
          if (Number(extra.is_todo) !== 1) return "\n☑️ Todo désactivé (note simple)";
          const due = Number(extra.todo_due || 0);
          const done = Number(extra.todo_completed || 0);
          return `\n☑️ Todo · échéance: ${due > 0 ? formatTimestamp(due) : "aucune"} · ${done > 0 ? `fait le ${formatTimestamp(done)}` : "à faire"}`;
        })();
        return { content: [{ type: "text" as const, text: `✅ Note mise à jour !\n📝 Titre: ${newTitle}\n🆔 ID: ${note_id}${todoLine}` }] };
      } catch (e: any) { return { content: [{ type: "text" as const, text: `Erreur: ${e.message}` }] }; }
    }
  );

  server.tool("delete_note", "Delete a note from Joplin (soft delete - moves to trash). IMPORTANT: You MUST call this function to delete a note. NEVER tell the user a note has been deleted without actually calling this function and receiving a success response. Deleted notes are filtered from search results automatically.",
    { note_id: z.string().describe("The ID of the note to delete") },
    async ({ note_id }) => {
      try {
        const result = await pool.query(
          `SELECT i.id, i.content FROM items i WHERE i.id = $1 AND i.jop_type = $2`,
          [note_id, JOP_TYPE_NOTE]
        );
        if (result.rows.length === 0) return { content: [{ type: "text" as const, text: `Note '${note_id}' non trouvée.` }] };
        const row: any = result.rows[0];
        const parsed = parseJoplinContent(row.content);
        const now = Date.now();
        // Soft delete: set deleted_time in JSON content
        const extra: Record<string, any> = {};
        if (parsed.json) {
          for (const [k, v] of Object.entries(parsed.json)) {
            if (!["title", "body", "source", "source_url"].includes(k)) extra[k] = v;
          }
        }
        const contentBytes = buildNoteContent(parsed.title, parsed.body, { ...extra, deleted_time: now, user_updated_time: now });
        await pool.query(
          `UPDATE items SET content = $1, content_size = $2, updated_time = $3, jop_updated_time = $4 WHERE id = $5`,
          [contentBytes, contentBytes.length, now, now, note_id]
        );
        // Record change so Joplin Server pushes the deletion to synced clients
        const userId = await getUserId();
        const jopIdResult = await pool.query(`SELECT jop_id FROM items WHERE id = $1`, [note_id]);
        const jopId = jopIdResult.rows.length > 0 ? jopIdResult.rows[0].jop_id : note_id;
        await recordChange({ itemId: note_id, itemType: JOP_TYPE_NOTE, changeType: CHANGE_DELETED, jopId, userId });
        return { content: [{ type: "text" as const, text: `🗑️ Note supprimée !\n📝 Titre: ${parsed.title}\n🆔 ID: ${note_id}\n💡 La note est dans la corbeille Joplin.` }] };
      } catch (e: any) { return { content: [{ type: "text" as const, text: `Erreur: ${e.message}` }] }; }
    }
  );

  server.tool("move_note", "Move a note to a different notebook. IMPORTANT: You MUST call this function to move a note. NEVER tell the user a note has been moved without actually calling this function. Use `search_notes` to find the note_id and `search_notebooks` to find the target_notebook_id.",
    {
      note_id: z.string().describe("The ID of the note to move"),
      target_notebook_id: z.string().describe("The ID of the destination notebook/folder")
    },
    async ({ note_id, target_notebook_id }) => {
      try {
        // Verify note exists
        const noteResult = await pool.query(`SELECT id, content FROM items WHERE id = $1 AND jop_type = $2`, [note_id, JOP_TYPE_NOTE]);
        if (noteResult.rows.length === 0) return { content: [{ type: "text" as const, text: `Note '${note_id}' non trouvée.` }] };
        // Verify target notebook exists
        const folderResult = await pool.query(`SELECT id, content FROM items WHERE id = $1 AND jop_type = $2`, [target_notebook_id, JOP_TYPE_FOLDER]);
        if (folderResult.rows.length === 0) return { content: [{ type: "text" as const, text: `Carnet '${target_notebook_id}' non trouvé. Utilise list_notebooks pour voir les carnets.` }] };
        const noteParsed = parseJoplinContent(noteResult.rows[0].content);
        const folderParsed = parseJoplinContent(folderResult.rows[0].content);
        const now = Date.now();
        // target_notebook_id is base62 'id' - need jop_id (UUID hex) for jop_parent_id
        const targetJopIdResult = await pool.query(`SELECT jop_id FROM items WHERE id = $1 AND jop_type = $2`, [target_notebook_id, JOP_TYPE_FOLDER]);
        const targetJopId = targetJopIdResult.rows.length > 0 ? targetJopIdResult.rows[0].jop_id : target_notebook_id;
        await pool.query(
          `UPDATE items SET jop_parent_id = $1, updated_time = $2, jop_updated_time = $3 WHERE id = $4`,
          [targetJopId, now, now, note_id]
        );
        // Record change so Joplin Server pushes the move to synced clients
        const userId = await getUserId();
        const jopIdResult = await pool.query(`SELECT jop_id FROM items WHERE id = $1`, [note_id]);
        const jopId = jopIdResult.rows.length > 0 ? jopIdResult.rows[0].jop_id : note_id;
        await recordChange({ itemId: note_id, itemType: JOP_TYPE_NOTE, changeType: CHANGE_UPDATED, jopId, userId, changeItemType: 1 });
        return { content: [{ type: "text" as const, text: `📦 Note déplacée !\n📝 Note: ${noteParsed.title}\n📂 Vers: ${folderParsed.title}` }] };
      } catch (e: any) { return { content: [{ type: "text" as const, text: `Erreur: ${e.message}` }] }; }
    }
  );

  server.tool("create_notebook", "Create a new notebook (folder) in Joplin. IMPORTANT: You MUST call this function to create a notebook. NEVER tell the user a notebook has been created without actually calling this function and receiving a success response.",
    {
      title: z.string().describe("Notebook title"),
      parent_notebook_id: z.string().optional().describe("Optional parent notebook ID for sub-notebooks"),
      icon: z.object({
        emoji: z.string().describe("The emoji displayed as the notebook icon (e.g. \"🏦\")"),
        name: z.string().optional().describe("Optional icon name/label (e.g. \"bank\")"),
        type: z.number().optional().describe("Optional icon type (defaults to 1 = emoji)")
      }).optional().describe("Optional notebook icon, e.g. { emoji: \"🏦\", name: \"bank\" }")
    },
    async ({ title, parent_notebook_id, icon }) => {
      try {
        const userId = await getUserId();
        const folderId = generateId();
        const now = Date.now();
        const jopId = generateJopId();
        const folderContent = JSON.stringify({
          title: title,
          deleted_time: 0,
          user_data: "",
          icon: icon ? buildIconString(icon) : "",
          master_key_id: "",
          is_shared: 0,
          encryption_cipher_text: "",
          user_updated_time: now,
          user_created_time: now
        });
        const contentBytes = Buffer.from(folderContent, "utf-8");
        // parent_notebook_id is the base62 'id' exposed by the MCP. The jop_parent_id column
        // stores the 'jop_id' (32-hex UUID), so it MUST be translated first; otherwise the
        // folder is orphaned (its parent cannot be resolved by synced Joplin clients).
        let parentJopId = "";
        if (parent_notebook_id) {
          const fr = await pool.query(
            `SELECT jop_id FROM items WHERE id = $1 AND jop_type = $2`,
            [parent_notebook_id, JOP_TYPE_FOLDER]
          );
          if (fr.rows.length === 0) {
            return { content: [{ type: "text" as const, text: `Carnet parent '${parent_notebook_id}' introuvable. Utilise list_notebooks pour trouver l'ID du parent.` }] };
          }
          parentJopId = fr.rows[0].jop_id;
        }
        await pool.query(
          `INSERT INTO items (id, name, mime_type, updated_time, created_time, content, content_size, jop_id, jop_parent_id, jop_share_id, jop_type, jop_encryption_applied, jop_updated_time, owner_id, content_storage_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [folderId, `${jopId}.md`, "text/markdown", now, now, contentBytes, contentBytes.length, jopId, parentJopId, "", JOP_TYPE_FOLDER, 0, now, userId, 1]
        );
        // Record item ownership so Joplin Server includes it in sync
        await recordUserItem({ itemId: folderId, userId });
        // Record change so Joplin Server pushes the new notebook to synced clients
        await recordChange({ itemId: folderId, itemType: JOP_TYPE_FOLDER, changeType: CHANGE_CREATED, jopId, userId });
        return { content: [{ type: "text" as const, text: `✅ Carnet créé !\n📂 Titre: ${title}${icon ? `\n🎨 Icône: ${icon.emoji}` : ""}\n🆔 ID: ${folderId}${parentJopId ? `\n📁 Sous-carnet de: ${parent_notebook_id}` : ""}` }] };
      } catch (e: any) { return { content: [{ type: "text" as const, text: `Erreur: ${e.message}` }] }; }
    }
  );

  server.tool("update_notebook", "Rename and/or set the icon of an existing notebook (folder) in Joplin. IMPORTANT: You MUST call this function to rename a notebook or change its icon. NEVER tell the user a notebook has been updated without actually calling this function and receiving a success response. Provide at least one of `title` or `icon`.",
    {
      notebook_id: z.string().describe("The ID of the notebook to update"),
      title: z.string().optional().describe("New notebook title (optional, keeps existing if not provided)"),
      icon: z.object({
        emoji: z.string().describe("The emoji displayed as the notebook icon (e.g. \"🤖\")"),
        name: z.string().optional().describe("Optional icon name/label (e.g. \"robot\")"),
        type: z.number().optional().describe("Optional icon type (defaults to 1 = emoji)")
      }).optional().describe("Optional notebook icon, e.g. { emoji: \"🤖\", name: \"robot\" }")
    },
    async ({ notebook_id, title, icon }) => {
      try {
        if (title === undefined && icon === undefined) {
          return { content: [{ type: "text" as const, text: "Erreur: fournis au moins un titre ou une icône à modifier." }] };
        }
        const userId = await getUserId();
        const result = await pool.query(
          `SELECT i.id, i.content, i.jop_id FROM items i WHERE i.id = $1 AND i.jop_type = $2`,
          [notebook_id, JOP_TYPE_FOLDER]
        );
        if (result.rows.length === 0) return { content: [{ type: "text" as const, text: `Carnet '${notebook_id}' non trouvé.` }] };
        const row: any = result.rows[0];
        const parsed = parseJoplinContent(row.content);
        if (parsed.isDeleted) return { content: [{ type: "text" as const, text: `Carnet '${notebook_id}' est dans la corbeille.` }] };
        const now = Date.now();
        // Preserve all existing fields; only change the title and/or the icon when provided
        const json: Record<string, any> = { ...parseRawJson(row.content), user_updated_time: now };
        if (title !== undefined) json.title = title;
        if (icon !== undefined) json.icon = buildIconString(icon);
        const contentBytes = Buffer.from(JSON.stringify(json), "utf-8");
        await pool.query(
          `UPDATE items SET content = $1, content_size = $2, updated_time = $3, jop_updated_time = $4 WHERE id = $5`,
          [contentBytes, contentBytes.length, now, now, notebook_id]
        );
        await recordChange({ itemId: notebook_id, itemType: JOP_TYPE_FOLDER, changeType: CHANGE_UPDATED, jopId: row.jop_id, userId });
        const changes: string[] = [];
        if (title !== undefined) changes.push(`📂 ${parsed.title} → ${title}`);
        if (icon !== undefined) changes.push(`🎨 Icône: ${icon.emoji}`);
        return { content: [{ type: "text" as const, text: `✅ Carnet mis à jour !\n${changes.join("\n")}\n🆔 ID: ${notebook_id}` }] };
      } catch (e: any) { return { content: [{ type: "text" as const, text: `Erreur: ${e.message}` }] }; }
    }
  );

  server.tool("move_notebook", "Move a notebook under another notebook, or back to the root with an empty parent_id. Refuses to nest a notebook inside itself or one of its descendants.",
    {
      notebook_id: z.string().describe("The ID of the notebook to move"),
      parent_id: z.string().describe("Target notebook ID, or an empty string to move it to the root")
    },
    async ({ notebook_id, parent_id }) => {
      try {
        const userId = await getUserId();
        const row = await findItem(notebook_id, JOP_TYPE_FOLDER, userId);
        if (!row) return { content: [{ type: "text" as const, text: `Carnet '${notebook_id}' non trouvé.` }] };
        const parsed = parseJoplinContent(row.content);
        if (parsed.isDeleted) return { content: [{ type: "text" as const, text: `Le carnet « ${parsed.title} » est dans la corbeille.` }] };
        const targetId = parent_id.trim();
        let targetJopId = "";
        let targetTitle = "";
        const folders = await pool.query(
          `SELECT id, jop_id, jop_parent_id, content FROM items WHERE owner_id = $1 AND jop_type = $2`,
          [userId, JOP_TYPE_FOLDER]
        );
        const alive = (folders.rows as JoplinItemRow[])
          .map((f) => ({
            id: f.id,
            jopId: String(f.jop_id),
            parent: String(f.jop_parent_id || ""),
            title: parseJoplinContent(f.content).title,
            deleted: parseJoplinContent(f.content).isDeleted
          }))
          .filter((f) => !f.deleted);
        if (targetId) {
          const target = alive.find((f) => f.id === targetId || f.jopId === targetId);
          if (!target) return { content: [{ type: "text" as const, text: `Carnet cible '${targetId}' non trouvé.` }] };
          if (target.jopId === row.jop_id) return { content: [{ type: "text" as const, text: "Un carnet ne peut pas être son propre parent." }] };
          // Walk down from the moved notebook: the target must not be one of its descendants
          const childrenOf = new Map<string, typeof alive>();
          for (const f of alive) {
            const bucket = childrenOf.get(f.parent) || [];
            bucket.push(f);
            childrenOf.set(f.parent, bucket);
          }
          const seen = new Set<string>([row.jop_id]);
          const stack = [row.jop_id];
          while (stack.length) {
            const current = stack.pop() as string;
            for (const child of childrenOf.get(current) || []) {
              if (seen.has(child.jopId)) continue;
              seen.add(child.jopId);
              stack.push(child.jopId);
            }
          }
          if (seen.has(target.jopId)) {
            return { content: [{ type: "text" as const, text: `Déplacement impossible : « ${target.title} » est un sous-carnet de « ${parsed.title} » (cycle).` }] };
          }
          targetJopId = target.jopId;
          targetTitle = target.title;
        }
        const now = Date.now();
        const contentBytes = Buffer.from(JSON.stringify({ ...parseRawJson(row.content), parent_id: targetJopId, user_updated_time: now }), "utf-8");
        await pool.query(
          `UPDATE items SET content = $1, content_size = $2, updated_time = $3, jop_updated_time = $3, jop_parent_id = $4 WHERE id = $5`,
          [contentBytes, contentBytes.length, now, targetJopId, row.id]
        );
        await recordChange({ itemId: row.id, itemType: JOP_TYPE_FOLDER, changeType: CHANGE_UPDATED, jopId: row.jop_id, userId, changeItemType: 1 });
        return {
          content: [{
            type: "text" as const,
            text: `✅ Carnet déplacé !\n📂 ${parsed.title} → ${targetTitle || "racine"}\n🆔 ID: ${row.id}`
          }]
        };
      } catch (e: any) { return { content: [{ type: "text" as const, text: `Erreur: ${e.message}` }] }; }
    }
  );

  server.tool("delete_notebook", "Delete a notebook (folder) from Joplin (soft delete - moves to trash). SAFETY: the notebook must be empty - if it still contains notes or sub-notebooks, move or delete them first. IMPORTANT: You MUST call this function to delete a notebook. NEVER tell the user a notebook has been deleted without actually calling this function and receiving a success response.",
    { notebook_id: z.string().describe("The ID of the notebook to delete") },
    async ({ notebook_id }) => {
      try {
        const userId = await getUserId();
        const result = await pool.query(
          `SELECT i.id, i.content, i.jop_id FROM items i WHERE i.id = $1 AND i.jop_type = $2`,
          [notebook_id, JOP_TYPE_FOLDER]
        );
        if (result.rows.length === 0) return { content: [{ type: "text" as const, text: `Carnet '${notebook_id}' non trouvé.` }] };
        const row: any = result.rows[0];
        const parsed = parseJoplinContent(row.content);
        if (parsed.isDeleted) return { content: [{ type: "text" as const, text: `Carnet '${notebook_id}' est déjà dans la corbeille.` }] };
        // Safety: refuse if the notebook is not empty (notes or sub-notebooks still inside)
        const children = await pool.query(
          `SELECT id, content FROM items WHERE jop_parent_id = $1 AND owner_id = $2`,
          [row.jop_id, userId]
        );
        const alive = children.rows.filter((c: any) => !parseJoplinContent(c.content).isDeleted);
        if (alive.length > 0) {
          return { content: [{ type: "text" as const, text: `⚠️ Le carnet "${parsed.title}" n'est pas vide (${alive.length} élément(s)). Déplace ou supprime d'abord ses notes et sous-carnets.` }] };
        }
        const now = Date.now();
        // Soft delete: set deleted_time, preserving all other fields (incl. the 'icon' string)
        const json = { ...parseRawJson(row.content), deleted_time: now, user_updated_time: now };
        const contentBytes = Buffer.from(JSON.stringify(json), "utf-8");
        await pool.query(
          `UPDATE items SET content = $1, content_size = $2, updated_time = $3, jop_updated_time = $4 WHERE id = $5`,
          [contentBytes, contentBytes.length, now, now, notebook_id]
        );
        await recordChange({ itemId: notebook_id, itemType: JOP_TYPE_FOLDER, changeType: CHANGE_DELETED, jopId: row.jop_id, userId });
        return { content: [{ type: "text" as const, text: `🗑️ Carnet supprimé !\n📂 Titre: ${parsed.title}\n🆔 ID: ${notebook_id}\n💡 Le carnet est dans la corbeille Joplin.` }] };
      } catch (e: any) { return { content: [{ type: "text" as const, text: `Erreur: ${e.message}` }] }; }
    }
  );

  // ====== RESOURCE (ATTACHMENT) TOOLS ======

  server.tool("list_note_attachments", "List the file attachments (resources) of a note. Returns resource IDs usable with `get_resource`, `download_resource`, `attach_resource_to_note` and `unlink_resource_from_note`.",
    {
      note_id: z.string().describe("The ID of the note (MCP id or Joplin 32-hex id)"),
      limit: z.number().default(50).describe("Max attachments to return")
    },
    async ({ note_id, limit }) => {
      try {
        const userId = await getUserId();
        const note = await findItem(note_id, JOP_TYPE_NOTE, userId);
        if (!note) return { content: [{ type: "text" as const, text: `Note '${note_id}' non trouvée.` }] };
        const resourceJopIds = await listNoteResourceIds(note);
        if (resourceJopIds.length === 0) return { content: [{ type: "text" as const, text: `La note '${note_id}' n'a aucune pièce jointe.` }] };
        const rows = await pool.query(
          `SELECT id, name, content, jop_id, jop_parent_id, jop_type, content_size, updated_time
           FROM items WHERE owner_id = $1 AND jop_type = $2 AND jop_id = ANY($3::text[])
           ORDER BY updated_time DESC LIMIT $4`,
          [userId, JOP_TYPE_RESOURCE, Array.from(resourceJopIds), Math.min(limit, 200)]
        );
        const resources = (rows.rows as JoplinItemRow[]).map(resourceSummary).filter((r) => !r.isDeleted);
        if (resources.length === 0) return { content: [{ type: "text" as const, text: `La note '${note_id}' n'a aucune pièce jointe disponible.` }] };
        const lines = resources.map((r) => `📎 **${r.title}** (ID: ${r.id})\n   jop_id: ${r.jopId} · ${formatBytes(r.size)} · ${r.mime}\n   Mis à jour: ${r.updated}`);
        return { content: [{ type: "text" as const, text: `📎 Pièces jointes (${resources.length}):\n\n${lines.join("\n\n")}` }] };
      } catch (e: any) { return { content: [{ type: "text" as const, text: `Erreur: ${e.message}` }] }; }
    }
  );

  server.tool("list_resources", "List the most recently updated file attachments (resources) across all notes. Returns resource IDs for `download_resource` / `attach_resource_to_note`.",
    {
      limit: z.number().default(20).describe("Max resources"),
      query: z.string().optional().describe("Optional text filter on the resource title")
    },
    async ({ limit, query }) => {
      try {
        const userId = await getUserId();
        const conditions = [`owner_id = $1`, `jop_type = $2`];
        const params: any[] = [userId, JOP_TYPE_RESOURCE];
        if (query) {
          params.push(`%${query}%`);
          conditions.push(`encode(content, 'escape') ILIKE $${params.length}`);
        }
        params.push(Math.min(limit, 100));
        const rows = await pool.query(
          `SELECT id, name, content, jop_id, jop_parent_id, jop_type, content_size, updated_time
           FROM items WHERE ${conditions.join(" AND ")}
           ORDER BY updated_time DESC LIMIT $${params.length}`,
          params
        );
        const resources = (rows.rows as JoplinItemRow[]).map(resourceSummary).filter((r) => !r.isDeleted);
        if (resources.length === 0) return { content: [{ type: "text" as const, text: "Aucune pièce jointe trouvée." }] };
        const lines = resources.map((r) => `📎 **${r.title}** (ID: ${r.id})\n   ${formatBytes(r.size)} · ${r.mime} · ${r.updated}`);
        return { content: [{ type: "text" as const, text: `📎 Pièces jointes récentes (${resources.length}):\n\n${lines.join("\n\n")}` }] };
      } catch (e: any) { return { content: [{ type: "text" as const, text: `Erreur: ${e.message}` }] }; }
    }
  );

  server.tool("get_resource", "Get the metadata of a file attachment (resource): title, MIME type, size, blob presence and the notes that reference it. Use `download_resource` for the bytes.",
    { resource_id: z.string().describe("The resource ID (MCP id or Joplin 32-hex id)") },
    async ({ resource_id }) => {
      try {
        const userId = await getUserId();
        const row = await findItem(resource_id, JOP_TYPE_RESOURCE, userId);
        if (!row) return { content: [{ type: "text" as const, text: `Ressource '${resource_id}' non trouvée.` }] };
        const summary = resourceSummary(row);
        const blob = await findResourceBlob(row.jop_id, userId);
        const usage = await pool.query(`SELECT item_id FROM item_resources WHERE resource_id = $1`, [row.jop_id]);
        const text = [
          `${summary.isDeleted ? "🗑️" : "📎"} **${summary.title}**`,
          `🆔 ID: ${summary.id}`,
          `🔑 jop_id: ${summary.jopId}`,
          `📦 Taille: ${formatBytes(summary.size)}`,
          `🏷️ Type: ${summary.mime}${summary.fileExtension ? ` (.${summary.fileExtension})` : ""}`,
          `🕐 Mis à jour: ${summary.updated}`,
          `💾 Blob: ${blob ? `${formatBytes(blob.content_size)} stockés` : "absent"}`,
          `🔗 Référencée par ${usage.rows.length} note(s)`,
          `⬇️ Téléchargement: ${MCP_PUBLIC_URL}/files/${summary.id} (en-tête Authorization: Bearer <clé MCP>)`
        ].join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) { return { content: [{ type: "text" as const, text: `Erreur: ${e.message}` }] }; }
    }
  );

  server.tool("download_resource", "Download a file attachment (resource) and return its bytes as base64. Inline output is capped (default 10 MiB, max 32 MiB); for bigger files use the GET /files/<id> endpoint of this server instead.",
    {
      resource_id: z.string().describe("The resource ID (MCP id or Joplin 32-hex id)"),
      max_bytes: z.number().optional().describe(`Inline size cap in bytes (default ${DEFAULT_INLINE_DOWNLOAD_MAX_BYTES}, max ${HARD_INLINE_DOWNLOAD_MAX_BYTES})`)
    },
    async ({ resource_id, max_bytes }) => {
      try {
        const userId = await getUserId();
        const row = await findItem(resource_id, JOP_TYPE_RESOURCE, userId);
        if (!row) return { content: [{ type: "text" as const, text: `Ressource '${resource_id}' non trouvée.` }] };
        const summary = resourceSummary(row);
        if (summary.isDeleted) return { content: [{ type: "text" as const, text: `Ressource '${resource_id}' est dans la corbeille.` }] };
        const blob = await findResourceBlob(row.jop_id, userId);
        if (!blob) return { content: [{ type: "text" as const, text: `Aucun contenu binaire pour la ressource '${resource_id}' (${summary.title}).` }] };
        const cap = Math.min(max_bytes ?? DEFAULT_INLINE_DOWNLOAD_MAX_BYTES, HARD_INLINE_DOWNLOAD_MAX_BYTES);
        if (blob.content.length > cap) {
          return {
            content: [{
              type: "text" as const,
              text: `⚠️ Fichier trop volumineux pour un retour inline (${formatBytes(blob.content.length)} > ${formatBytes(cap)}).\n` +
                `Utilise l'endpoint binaire :\n` +
                `curl -fsSL -H "Authorization: Bearer $JOPLIN_API_KEY" "${MCP_PUBLIC_URL}/files/${summary.id}" -o "${summary.title}"`
            }]
          };
        }
        const header = `📎 ${summary.title}\n🆔 ID: ${summary.id} · jop_id: ${summary.jopId}\n🏷️ ${summary.mime} · ${formatBytes(blob.content.length)}\nBase64 (${summary.fileExtension || "bin"}):`;
        return { content: [{ type: "text" as const, text: `${header}\n${blob.content.toString("base64")}` }] };
      } catch (e: any) { return { content: [{ type: "text" as const, text: `Erreur: ${e.message}` }] }; }
    }
  );

  server.tool("add_resource", "Attach a file to a note from inline base64 content (small files only, max 32 MiB). Creates the Joplin resource (metadata + binary blob) and, when note_id is provided, appends the markdown link to the note. For bigger files use the POST /files endpoint of this server.",
    {
      filename: z.string().describe("File name including extension (used as the resource title)"),
      data_base64: z.string().describe("File content encoded in base64 (data: URL prefix accepted)"),
      note_id: z.string().optional().describe("Optional note ID to attach the new resource to"),
      mime_type: z.string().optional().describe("Optional MIME type (guessed from the extension when omitted)"),
      as_image: z.boolean().optional().describe("Insert an image link (![...]) instead of a file link")
    },
    async ({ filename, data_base64, note_id, mime_type, as_image }) => {
      try {
        const userId = await getUserId();
        const cleaned = data_base64.replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
        const data = Buffer.from(cleaned, "base64");
        if (data.length === 0) return { content: [{ type: "text" as const, text: "Erreur: contenu base64 vide ou invalide." }] };
        if (data.length > HARD_INLINE_DOWNLOAD_MAX_BYTES) {
          return { content: [{ type: "text" as const, text: `⚠️ Fichier trop volumineux pour un ajout inline (${formatBytes(data.length)} > ${formatBytes(HARD_INLINE_DOWNLOAD_MAX_BYTES)}). Utilise POST /files.` }] };
        }
        let note: JoplinItemRow | null = null;
        if (note_id) {
          note = await findItem(note_id, JOP_TYPE_NOTE, userId);
          if (!note) return { content: [{ type: "text" as const, text: `Note '${note_id}' non trouvée.` }] };
        }
        const resource = await createResource({ title: filename, data, mime: mime_type, userId });
        let attachNote = "";
        if (note) {
          await appendResourceLinkToNote(note, resource.title, resource.jopId, as_image === true);
          attachNote = `\n📝 Liée à la note: ${note.id}`;
        }
        return {
          content: [{
            type: "text" as const,
            text: `✅ Pièce jointe créée !\n📎 ${resource.title}\n🆔 ID: ${resource.id}\n🔑 jop_id: ${resource.jopId}\n📦 ${formatBytes(resource.size)} · ${resource.mime}${attachNote}`
          }]
        };
      } catch (e: any) { return { content: [{ type: "text" as const, text: `Erreur: ${e.message}` }] }; }
    }
  );

  server.tool("attach_resource_to_note", "Append a markdown link to an existing resource (attachment) into a note body. The resource must already exist (see `list_resources` / `add_resource`). Idempotent at the note body level: check `list_note_attachments` first if unsure.",
    {
      note_id: z.string().describe("The ID of the target note"),
      resource_id: z.string().describe("The resource ID (MCP id or Joplin 32-hex id)"),
      label: z.string().optional().describe("Optional link label (defaults to the resource title)"),
      as_image: z.boolean().optional().describe("Insert an image link (![...]) instead of a file link")
    },
    async ({ note_id, resource_id, label, as_image }) => {
      try {
        const userId = await getUserId();
        const note = await findItem(note_id, JOP_TYPE_NOTE, userId);
        if (!note) return { content: [{ type: "text" as const, text: `Note '${note_id}' non trouvée.` }] };
        const resource = await findItem(resource_id, JOP_TYPE_RESOURCE, userId);
        if (!resource) return { content: [{ type: "text" as const, text: `Ressource '${resource_id}' non trouvée.` }] };
        const summary = resourceSummary(resource);
        if (summary.isDeleted) return { content: [{ type: "text" as const, text: `Ressource '${resource_id}' est dans la corbeille.` }] };
        await appendResourceLinkToNote(note, label || summary.title, resource.jop_id, as_image === true);
        return { content: [{ type: "text" as const, text: `✅ Pièce jointe liée !\n📎 ${summary.title}\n📝 Note: ${note.id}` }] };
      } catch (e: any) { return { content: [{ type: "text" as const, text: `Erreur: ${e.message}` }] }; }
    }
  );

  server.tool("unlink_resource_from_note", "Remove the markdown links pointing at a resource from a note body. The resource itself is kept (it can stay attached to other notes or be downloaded later).",
    {
      note_id: z.string().describe("The ID of the note"),
      resource_id: z.string().describe("The resource ID (MCP id or Joplin 32-hex id)")
    },
    async ({ note_id, resource_id }) => {
      try {
        const userId = await getUserId();
        const note = await findItem(note_id, JOP_TYPE_NOTE, userId);
        if (!note) return { content: [{ type: "text" as const, text: `Note '${note_id}' non trouvée.` }] };
        const resource = await findItem(resource_id, JOP_TYPE_RESOURCE, userId);
        if (!resource) return { content: [{ type: "text" as const, text: `Ressource '${resource_id}' non trouvée.` }] };
        const removed = await removeResourceLinksFromNote(note, resource.jop_id);
        const summary = resourceSummary(resource);
        return {
          content: [{
            type: "text" as const,
            text: removed > 0
              ? `✅ Lien retiré (${removed} occurrence(s)) !\n📎 ${summary.title}\n📝 Note: ${note.id}\n💡 La ressource existe toujours dans Joplin.`
              : `Aucun lien vers '${summary.title}' dans la note ${note.id}.`
          }]
        };
      } catch (e: any) { return { content: [{ type: "text" as const, text: `Erreur: ${e.message}` }] }; }
    }
  );

  server.tool("delete_resource", "Delete a file attachment (resource): soft delete to the Joplin trash, same semantics as delete_note. The binary blob stays on the server until the trash is emptied from a client. Refuses when the resource is still linked from notes unless `force` is set (note bodies would keep dangling links).",
    {
      resource_id: z.string().describe("The resource ID (MCP id or Joplin 32-hex id)"),
      force: z.boolean().optional().describe("Delete even when still referenced by notes")
    },
    async ({ resource_id, force }) => {
      try {
        const userId = await getUserId();
        const row = await findItem(resource_id, JOP_TYPE_RESOURCE, userId);
        if (!row) return { content: [{ type: "text" as const, text: `Ressource '${resource_id}' non trouvée.` }] };
        const summary = resourceSummary(row);
        if (summary.isDeleted) return { content: [{ type: "text" as const, text: `Ressource '${summary.title}' est déjà dans la corbeille.` }] };
        const refs = await pool.query(`SELECT item_id FROM item_resources WHERE resource_id = $1`, [row.jop_id]);
        if (refs.rows.length > 0 && force !== true) {
          const noteRows = await pool.query(`SELECT id, content FROM items WHERE id = ANY($1::text[])`, [refs.rows.map((r: any) => r.item_id)]);
          const titles = noteRows.rows.map((r: any) => parseJoplinContent(r.content).title || r.id);
          return {
            content: [{
              type: "text" as const,
              text: `⚠️ Ressource '${summary.title}' encore référencée par ${refs.rows.length} note(s) : ${titles.join(", ")}.\n` +
                `Fais d'abord unlink_resource_from_note, ou relance avec force=true.`
            }]
          };
        }
        const now = Date.now();
        const json = { ...parseRawJson(row.content), deleted_time: now, user_updated_time: now };
        const contentBytes = Buffer.from(JSON.stringify(json), "utf-8");
        await pool.query(
          `UPDATE items SET content = $1, content_size = $2, updated_time = $3, jop_updated_time = $3 WHERE id = $4`,
          [contentBytes, contentBytes.length, now, row.id]
        );
        await recordChange({ itemId: row.id, itemType: JOP_TYPE_RESOURCE, changeType: CHANGE_DELETED, jopId: row.jop_id, userId, changeItemType: 2 });
        const linksNote = refs.rows.length > 0 ? `\n💡 ${refs.rows.length} lien(s) restent dans les corps de notes (rendu = pièce manquante).` : "";
        return {
          content: [{
            type: "text" as const,
            text: `🗑️ Pièce jointe mise à la corbeille !\n📎 ${summary.title}\n🆔 ID: ${summary.id}\n💡 Le binaire reste sur le serveur jusqu'à la purge de la corbeille.${linksNote}`
          }]
        };
      } catch (e: any) { return { content: [{ type: "text" as const, text: `Erreur: ${e.message}` }] }; }
    }
  );

  server.tool("update_resource", "Replace the binary content of an existing attachment (new version of a file). Ids are preserved, so every link already present in note bodies keeps working. Inline base64 only (max 32 MiB); for bigger files use `PUT /files/<id>` with the raw body.",
    {
      resource_id: z.string().describe("The resource ID (MCP id or Joplin 32-hex id)"),
      data_base64: z.string().describe("New file content encoded in base64 (data: URL prefix accepted)"),
      filename: z.string().optional().describe("Optional new file name (updates the resource title and extension)"),
      mime_type: z.string().optional().describe("Optional MIME type (guessed from the file name when omitted)")
    },
    async ({ resource_id, data_base64, filename, mime_type }) => {
      try {
        const userId = await getUserId();
        const row = await findItem(resource_id, JOP_TYPE_RESOURCE, userId);
        if (!row) return { content: [{ type: "text" as const, text: `Pièce jointe '${resource_id}' non trouvée.` }] };
        const summary = resourceSummary(row);
        if (summary.isDeleted) return { content: [{ type: "text" as const, text: `« ${summary.title} » est dans la corbeille : restaure-la avec restore_item avant de remplacer son contenu.` }] };
        const cleaned = data_base64.replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
        const data = Buffer.from(cleaned, "base64");
        if (data.length === 0) return { content: [{ type: "text" as const, text: "Erreur: contenu base64 vide ou invalide." }] };
        if (data.length > HARD_INLINE_DOWNLOAD_MAX_BYTES) {
          return { content: [{ type: "text" as const, text: `⚠️ Fichier trop volumineux pour un remplacement inline (${formatBytes(data.length)} > ${formatBytes(HARD_INLINE_DOWNLOAD_MAX_BYTES)}). Utilise PUT /files/${summary.id}.` }] };
        }
        const result = await replaceResourceContent({ resource: row, data, mime: mime_type, filename, userId });
        return {
          content: [{
            type: "text" as const,
            text: `✅ Contenu remplacé !\n📎 ${result.title}\n🆔 ID: ${result.id}\n🔑 jop_id: ${result.jopId} (inchangé — les liens des notes restent valides)\n📦 ${formatBytes(result.sizeBefore)} → ${formatBytes(result.size)} · ${result.mime}`
          }]
        };
      } catch (e: any) { return { content: [{ type: "text" as const, text: `Erreur: ${e.message}` }] }; }
    }
  );

  server.tool("list_trash", "List the items currently sitting in the Joplin trash: notes and resources deleted but not purged. Use `restore_item` to bring one back.",
    {
      kind: z.enum(["all", "notes", "resources"]).default("all").describe("Restrict the listing to notes, resources, or both"),
      limit: z.number().default(50).describe("Max items to return")
    },
    async ({ kind, limit }) => {
      try {
        const userId = await getUserId();
        const types = kind === "notes" ? [JOP_TYPE_NOTE] : kind === "resources" ? [JOP_TYPE_RESOURCE] : [JOP_TYPE_NOTE, JOP_TYPE_RESOURCE];
        const rows = await pool.query(
          `SELECT id, name, content, jop_id, jop_type, content_size, updated_time
           FROM items
           WHERE owner_id = $1 AND jop_type = ANY($2::int[])
             AND encode(content, 'escape') ~ '"deleted_time"[[:space:]]*:[[:space:]]*[1-9]'
           ORDER BY updated_time DESC LIMIT $3`,
          [userId, types, Math.min(limit, 200)]
        );
        const items = (rows.rows as JoplinItemRow[])
          .map((row) => {
            const json = parseRawJson(row.content);
            return {
              id: row.id,
              jopId: row.jop_id,
              type: row.jop_type === JOP_TYPE_NOTE ? "note" : "ressource",
              title: String(json.title || "(sans titre)"),
              deletedAt: formatTimestamp(Number(json.deleted_time || 0)),
              size: Number(json.size || 0)
            };
          })
          .filter((i) => i.deletedAt !== "N/A");
        if (items.length === 0) return { content: [{ type: "text" as const, text: "La corbeille est vide." }] };
        const lines = items.map((i) =>
          `🗑️ **${i.title}** (${i.type})\n   ID: ${i.id} · jop_id: ${i.jopId} · supprimé le ${i.deletedAt}${i.type === "ressource" ? ` · ${formatBytes(i.size)}` : ""}`
        );
        return { content: [{ type: "text" as const, text: `🗑️ Corbeille (${items.length}):\n\n${lines.join("\n\n")}` }] };
      } catch (e: any) { return { content: [{ type: "text" as const, text: `Erreur: ${e.message}` }] }; }
    }
  );

  server.tool("restore_item", "Restore an item from the Joplin trash (note or resource): clears deleted_time and records an update so synced clients bring it back. The original ids (and therefore the note links) are preserved.",
    { item_id: z.string().describe("The note or resource ID (MCP id or Joplin 32-hex id)") },
    async ({ item_id }) => {
      try {
        const userId = await getUserId();
        const row = (await findItem(item_id, JOP_TYPE_NOTE, userId)) || (await findItem(item_id, JOP_TYPE_RESOURCE, userId));
        if (!row) return { content: [{ type: "text" as const, text: `Élément '${item_id}' non trouvé (ni note ni ressource).` }] };
        const json = parseRawJson(row.content);
        const title = String(json.title || "(sans titre)");
        if (!(Number(json.deleted_time || 0) > 0)) {
          return { content: [{ type: "text" as const, text: `« ${title} » n'est pas dans la corbeille.` }] };
        }
        const now = Date.now();
        const contentBytes = Buffer.from(JSON.stringify({ ...json, deleted_time: 0, user_updated_time: now }), "utf-8");
        await pool.query(
          `UPDATE items SET content = $1, content_size = $2, updated_time = $3, jop_updated_time = $3 WHERE id = $4`,
          [contentBytes, contentBytes.length, now, row.id]
        );
        await recordChange({ itemId: row.id, itemType: row.jop_type, changeType: CHANGE_UPDATED, jopId: row.jop_id, userId, changeItemType: 1 });
        const kindLabel = row.jop_type === JOP_TYPE_NOTE ? "Note" : "Pièce jointe";
        return { content: [{ type: "text" as const, text: `♻️ ${kindLabel} restaurée !\n📄 ${title}\n🆔 ID: ${row.id}` }] };
      } catch (e: any) { return { content: [{ type: "text" as const, text: `Erreur: ${e.message}` }] }; }
    }
  );

  // ====== TAG TOOLS ======

  server.tool("list_tags", "List all Joplin tags with their note counts. Use the returned tag ID with `attach_tag_to_note` / `detach_tag_from_note`.",
    {},
    async () => {
      try {
        const userId = await getUserId();
        const tags = await pool.query(
          `SELECT id, name, content, jop_id, jop_parent_id, jop_type, content_size, updated_time
           FROM items WHERE owner_id = $1 AND jop_type = $2 ORDER BY updated_time DESC`,
          [userId, JOP_TYPE_TAG]
        );
        const relations = await pool.query(`SELECT content FROM items WHERE owner_id = $1 AND jop_type = $2`, [userId, JOP_TYPE_NOTE_TAG]);
        const counts = new Map<string, number>();
        for (const row of relations.rows) {
          const json = parseRawJson(row.content);
          if (Number(json.deleted_time || 0) > 0) continue;
          const tagId = String(json.tag_id || "");
          counts.set(tagId, (counts.get(tagId) || 0) + 1);
        }
        const alive = (tags.rows as JoplinItemRow[])
          .filter((row) => !(parseJoplinContent(row.content).isDeleted))
          .map((row) => ({ id: row.id, jopId: row.jop_id, title: parseJoplinContent(row.content).title, count: counts.get(row.jop_id) || 0 }))
          .sort((a, b) => a.title.localeCompare(b.title));
        if (alive.length === 0) return { content: [{ type: "text" as const, text: "Aucun tag trouvé." }] };
        const lines = alive.map((t) => `🏷️ **${t.title}** (ID: ${t.id}) - ${t.count} note(s)`);
        return { content: [{ type: "text" as const, text: `🏷️ Tags (${alive.length}):\n\n${lines.join("\n")}` }] };
      } catch (e: any) { return { content: [{ type: "text" as const, text: `Erreur: ${e.message}` }] }; }
    }
  );

  server.tool("add_tag", "Create a new Joplin tag. Returns the tag ID for `attach_tag_to_note`.",
    { title: z.string().describe("Tag title") },
    async ({ title }) => {
      try {
        const userId = await getUserId();
        const trimmed = title.trim();
        if (!trimmed) return { content: [{ type: "text" as const, text: "Erreur: le titre du tag est vide." }] };
        const existing = await pool.query(
          `SELECT id, content FROM items WHERE owner_id = $1 AND jop_type = $2 AND encode(content, 'escape') ILIKE $3`,
          [userId, JOP_TYPE_TAG, `%${trimmed}%`]
        );
        const duplicate = existing.rows.find((row: any) => parseJoplinContent(row.content).title === trimmed && !parseJoplinContent(row.content).isDeleted);
        if (duplicate) return { content: [{ type: "text" as const, text: `🏷️ Le tag "${trimmed}" existe déjà (ID: ${duplicate.id}).` }] };
        const tagId = generateId();
        const jopId = generateJopId();
        const now = Date.now();
        const contentBytes = buildTagContent(trimmed, now);
        await pool.query(
          `INSERT INTO items (id, name, mime_type, updated_time, created_time, content, content_size, jop_id, jop_parent_id, jop_share_id, jop_type, jop_encryption_applied, jop_updated_time, owner_id, content_storage_id)
           VALUES ($1, $2, 'text/markdown', $3, $3, $4, $5, $6, '', '', $7, 0, $3, $8, 1)`,
          [tagId, `${jopId}.md`, now, contentBytes, contentBytes.length, jopId, JOP_TYPE_TAG, userId]
        );
        await recordUserItem({ itemId: tagId, userId });
        await recordChange({ itemId: tagId, itemType: JOP_TYPE_TAG, changeType: CHANGE_CREATED, jopId, userId, changeItemType: 2 });
        return { content: [{ type: "text" as const, text: `✅ Tag créé !\n🏷️ ${trimmed}\n🆔 ID: ${tagId}\n🔑 jop_id: ${jopId}` }] };
      } catch (e: any) { return { content: [{ type: "text" as const, text: `Erreur: ${e.message}` }] }; }
    }
  );

  server.tool("list_note_tags", "List the tags assigned to a note.",
    { note_id: z.string().describe("The ID of the note") },
    async ({ note_id }) => {
      try {
        const userId = await getUserId();
        const note = await findItem(note_id, JOP_TYPE_NOTE, userId);
        if (!note) return { content: [{ type: "text" as const, text: `Note '${note_id}' non trouvée.` }] };
        const relations = await pool.query(`SELECT id, content FROM items WHERE owner_id = $1 AND jop_type = $2`, [userId, JOP_TYPE_NOTE_TAG]);
        const tagJopIds = relations.rows
          .map((row: any) => ({ row, json: parseRawJson(row.content) }))
          .filter(({ json }: any) => json.note_id === note.jop_id && Number(json.deleted_time || 0) === 0)
          .map(({ json }: any) => String(json.tag_id));
        if (tagJopIds.length === 0) return { content: [{ type: "text" as const, text: `La note '${note_id}' n'a aucun tag.` }] };
        const tags = await pool.query(
          `SELECT id, name, content, jop_id, jop_parent_id, jop_type, content_size, updated_time
           FROM items WHERE owner_id = $1 AND jop_type = $2 AND jop_id = ANY($3::text[])`,
          [userId, JOP_TYPE_TAG, tagJopIds]
        );
        const tagsList = (tags.rows as JoplinItemRow[])
          .map((row) => ({ id: row.id, title: parseJoplinContent(row.content).title }))
          .filter((t) => t.title)
          .sort((a, b) => a.title.localeCompare(b.title));
        const lines = tagsList.map((t) => `🏷️ **${t.title}** (ID: ${t.id})`);
        return { content: [{ type: "text" as const, text: `🏷️ Tags de la note (${tagsList.length}):\n\n${lines.join("\n")}` }] };
      } catch (e: any) { return { content: [{ type: "text" as const, text: `Erreur: ${e.message}` }] }; }
    }
  );

  server.tool("attach_tag_to_note", "Assign a tag to a note. Creates the note<->tag relation item used by Joplin sync; no-op if the tag is already assigned.",
    {
      note_id: z.string().describe("The ID of the note"),
      tag_id: z.string().describe("The tag ID (MCP id or Joplin 32-hex id)")
    },
    async ({ note_id, tag_id }) => {
      try {
        const userId = await getUserId();
        const note = await findItem(note_id, JOP_TYPE_NOTE, userId);
        if (!note) return { content: [{ type: "text" as const, text: `Note '${note_id}' non trouvée.` }] };
        const tag = await findItem(tag_id, JOP_TYPE_TAG, userId);
        if (!tag) return { content: [{ type: "text" as const, text: `Tag '${tag_id}' non trouvé.` }] };
        const relations = await pool.query(`SELECT id, content FROM items WHERE owner_id = $1 AND jop_type = $2`, [userId, JOP_TYPE_NOTE_TAG]);
        const already = relations.rows.some((row: any) => {
          const json = parseRawJson(row.content);
          return String(json.tag_id || "") === tag.jop_id && String(json.note_id || "") === note.jop_id && Number(json.deleted_time || 0) === 0;
        });
        if (already) {
          return { content: [{ type: "text" as const, text: `🏷️ Le tag "${parseJoplinContent(tag.content).title}" est déjà assigné à la note ${note.id}.` }] };
        }
        const relId = generateId();
        const jopId = generateJopId();
        const now = Date.now();
        const contentBytes = buildNoteTagContent(tag.jop_id, note.jop_id, now);
        await pool.query(
          `INSERT INTO items (id, name, mime_type, updated_time, created_time, content, content_size, jop_id, jop_parent_id, jop_share_id, jop_type, jop_encryption_applied, jop_updated_time, owner_id, content_storage_id)
           VALUES ($1, $2, 'text/markdown', $3, $3, $4, $5, $6, '', '', $7, 0, $3, $8, 1)`,
          [relId, `${jopId}.md`, now, contentBytes, contentBytes.length, jopId, JOP_TYPE_NOTE_TAG, userId]
        );
        await recordUserItem({ itemId: relId, userId });
        await recordChange({ itemId: relId, itemType: JOP_TYPE_NOTE_TAG, changeType: CHANGE_CREATED, jopId, userId, changeItemType: 2 });
        return { content: [{ type: "text" as const, text: `✅ Tag assigné !\n🏷️ ${parseJoplinContent(tag.content).title}\n📝 Note: ${note.id}` }] };
      } catch (e: any) { return { content: [{ type: "text" as const, text: `Erreur: ${e.message}` }] }; }
    }
  );

  server.tool("detach_tag_from_note", "Remove a tag from a note (soft-deletes the note<->tag relation item). The tag itself is kept.",
    {
      note_id: z.string().describe("The ID of the note"),
      tag_id: z.string().describe("The tag ID (MCP id or Joplin 32-hex id)")
    },
    async ({ note_id, tag_id }) => {
      try {
        const userId = await getUserId();
        const note = await findItem(note_id, JOP_TYPE_NOTE, userId);
        if (!note) return { content: [{ type: "text" as const, text: `Note '${note_id}' non trouvée.` }] };
        const tag = await findItem(tag_id, JOP_TYPE_TAG, userId);
        if (!tag) return { content: [{ type: "text" as const, text: `Tag '${tag_id}' non trouvé.` }] };
        const relations = await pool.query(`SELECT id, content, jop_id FROM items WHERE owner_id = $1 AND jop_type = $2`, [userId, JOP_TYPE_NOTE_TAG]);
        const matches = relations.rows.filter((row: any) => {
          const json = parseRawJson(row.content);
          return String(json.tag_id || "") === tag.jop_id && String(json.note_id || "") === note.jop_id && Number(json.deleted_time || 0) === 0;
        });
        if (matches.length === 0) {
          return { content: [{ type: "text" as const, text: `Le tag "${parseJoplinContent(tag.content).title}" n'est pas assigné à la note ${note.id}.` }] };
        }
        const now = Date.now();
        for (const rel of matches) {
          const json = { ...parseRawJson(rel.content), deleted_time: now, user_updated_time: now };
          const contentBytes = Buffer.from(JSON.stringify(json), "utf-8");
          await pool.query(
            `UPDATE items SET content = $1, content_size = $2, updated_time = $3, jop_updated_time = $3 WHERE id = $4`,
            [contentBytes, contentBytes.length, now, rel.id]
          );
          await recordChange({ itemId: rel.id, itemType: JOP_TYPE_NOTE_TAG, changeType: CHANGE_DELETED, jopId: rel.jop_id, userId, changeItemType: 2 });
        }
        return { content: [{ type: "text" as const, text: `✅ Tag retiré !\n🏷️ ${parseJoplinContent(tag.content).title}\n📝 Note: ${note.id}` }] };
      } catch (e: any) { return { content: [{ type: "text" as const, text: `Erreur: ${e.message}` }] }; }
    }
  );

  server.tool("list_notes_with_tag", "List the notes carrying a tag, most recently updated first (resolves the note<->tag relations used by Joplin sync).",
    {
      tag_id: z.string().describe("The tag ID (MCP id or Joplin 32-hex id)"),
      limit: z.number().default(50).describe("Max notes to return")
    },
    async ({ tag_id, limit }) => {
      try {
        const userId = await getUserId();
        const tag = await findItem(tag_id, JOP_TYPE_TAG, userId);
        if (!tag) return { content: [{ type: "text" as const, text: `Tag '${tag_id}' non trouvé.` }] };
        const tagTitle = parseJoplinContent(tag.content).title;
        if (parseJoplinContent(tag.content).isDeleted) return { content: [{ type: "text" as const, text: `Le tag "${tagTitle}" est dans la corbeille.` }] };
        const relations = await pool.query(`SELECT content FROM items WHERE owner_id = $1 AND jop_type = $2`, [userId, JOP_TYPE_NOTE_TAG]);
        const noteJopIds = relations.rows
          .map((row: any) => parseRawJson(row.content))
          .filter((json: any) => String(json.tag_id || "") === tag.jop_id && Number(json.deleted_time || 0) === 0)
          .map((json: any) => String(json.note_id || ""));
        if (noteJopIds.length === 0) return { content: [{ type: "text" as const, text: `Le tag "${tagTitle}" n'est assigné à aucune note.` }] };
        const notes = await pool.query(
          `SELECT id, content, jop_id, jop_parent_id, updated_time FROM items
           WHERE owner_id = $1 AND jop_type = $2 AND jop_id = ANY($3::text[])`,
          [userId, JOP_TYPE_NOTE, noteJopIds]
        );
        const folders = await pool.query(`SELECT jop_id, content FROM items WHERE owner_id = $1 AND jop_type = $2`, [userId, JOP_TYPE_FOLDER]);
        const folderTitles = new Map<string, string>();
        for (const f of folders.rows as JoplinItemRow[]) folderTitles.set(String(f.jop_id), parseJoplinContent(f.content).title);
        const alive = (notes.rows as JoplinItemRow[])
          .map((row) => ({
            id: row.id,
            title: parseJoplinContent(row.content).title,
            deleted: parseJoplinContent(row.content).isDeleted,
            notebook: folderTitles.get(String(row.jop_parent_id)) || "",
            updated: Number(row.updated_time)
          }))
          .filter((n) => !n.deleted)
          .sort((a, b) => b.updated - a.updated);
        if (alive.length === 0) return { content: [{ type: "text" as const, text: `Le tag "${tagTitle}" n'est assigné à aucune note active.` }] };
        const shown = alive.slice(0, Math.min(limit, 200));
        const lines = shown.map((n) => `📝 **${n.title}**\n   ID: ${n.id}${n.notebook ? ` · carnet: ${n.notebook}` : ""} · maj ${formatTimestamp(n.updated)}`);
        return { content: [{ type: "text" as const, text: `🏷️ Notes avec le tag "${tagTitle}" (${alive.length}, ${shown.length} affichées):\n\n${lines.join("\n\n")}` }] };
      } catch (e: any) { return { content: [{ type: "text" as const, text: `Erreur: ${e.message}` }] }; }
    }
  );

  server.tool("rename_tag", "Rename a tag. The tag id is kept, so every note assignment survives.",
    {
      tag_id: z.string().describe("The tag ID (MCP id or Joplin 32-hex id)"),
      title: z.string().describe("New tag title")
    },
    async ({ tag_id, title }) => {
      try {
        const userId = await getUserId();
        const tag = await findItem(tag_id, JOP_TYPE_TAG, userId);
        if (!tag) return { content: [{ type: "text" as const, text: `Tag '${tag_id}' non trouvé.` }] };
        const current = parseJoplinContent(tag.content);
        if (current.isDeleted) return { content: [{ type: "text" as const, text: `Le tag "${current.title}" est dans la corbeille.` }] };
        const trimmed = title.trim();
        if (!trimmed) return { content: [{ type: "text" as const, text: "Erreur: le nouveau titre est vide." }] };
        if (trimmed === current.title) return { content: [{ type: "text" as const, text: `Le tag s'appelle déjà "${trimmed}" (ID: ${tag.id}).` }] };
        const others = await pool.query(
          `SELECT id, content FROM items WHERE owner_id = $1 AND jop_type = $2 AND id <> $3`,
          [userId, JOP_TYPE_TAG, tag.id]
        );
        const clash = others.rows.find((row: any) => {
          const parsed = parseJoplinContent(row.content);
          return !parsed.isDeleted && parsed.title === trimmed;
        });
        if (clash) {
          return { content: [{ type: "text" as const, text: `Un tag "${trimmed}" existe déjà (ID: ${clash.id}) — renommer créerait un doublon. Utilise attach_tag_to_note puis detach/detach_tag_from_note pour fusionner à la main.` }] };
        }
        const now = Date.now();
        const contentBytes = Buffer.from(JSON.stringify({ ...parseRawJson(tag.content), title: trimmed, user_updated_time: now }), "utf-8");
        await pool.query(
          `UPDATE items SET content = $1, content_size = $2, updated_time = $3, jop_updated_time = $3 WHERE id = $4`,
          [contentBytes, contentBytes.length, now, tag.id]
        );
        await recordChange({ itemId: tag.id, itemType: JOP_TYPE_TAG, changeType: CHANGE_UPDATED, jopId: tag.jop_id, userId, changeItemType: 1 });
        return { content: [{ type: "text" as const, text: `✅ Tag renommé !\n🏷️ ${current.title} → ${trimmed}\n🆔 ID: ${tag.id}` }] };
      } catch (e: any) { return { content: [{ type: "text" as const, text: `Erreur: ${e.message}` }] }; }
    }
  );

  server.tool("delete_tag", "Delete a tag: trashes the tag and all its note assignments (soft delete, same as the desktop). The notes themselves are never touched.",
    { tag_id: z.string().describe("The tag ID (MCP id or Joplin 32-hex id)") },
    async ({ tag_id }) => {
      try {
        const userId = await getUserId();
        const tag = await findItem(tag_id, JOP_TYPE_TAG, userId);
        if (!tag) return { content: [{ type: "text" as const, text: `Tag '${tag_id}' non trouvé.` }] };
        const parsedTag = parseJoplinContent(tag.content);
        if (parsedTag.isDeleted) return { content: [{ type: "text" as const, text: `Le tag "${parsedTag.title}" est déjà dans la corbeille.` }] };
        const now = Date.now();
        const relations = await pool.query(`SELECT id, content, jop_id FROM items WHERE owner_id = $1 AND jop_type = $2`, [userId, JOP_TYPE_NOTE_TAG]);
        const alive = relations.rows.filter((row: any) => {
          const json = parseRawJson(row.content);
          return String(json.tag_id || "") === tag.jop_id && Number(json.deleted_time || 0) === 0;
        });
        for (const rel of alive) {
          const contentBytes = Buffer.from(JSON.stringify({ ...parseRawJson(rel.content), deleted_time: now, user_updated_time: now }), "utf-8");
          await pool.query(
            `UPDATE items SET content = $1, content_size = $2, updated_time = $3, jop_updated_time = $3 WHERE id = $4`,
            [contentBytes, contentBytes.length, now, rel.id]
          );
          await recordChange({ itemId: rel.id, itemType: JOP_TYPE_NOTE_TAG, changeType: CHANGE_DELETED, jopId: rel.jop_id, userId, changeItemType: 2 });
        }
        const contentBytes = Buffer.from(JSON.stringify({ ...parseRawJson(tag.content), deleted_time: now, user_updated_time: now }), "utf-8");
        await pool.query(
          `UPDATE items SET content = $1, content_size = $2, updated_time = $3, jop_updated_time = $3 WHERE id = $4`,
          [contentBytes, contentBytes.length, now, tag.id]
        );
        await recordChange({ itemId: tag.id, itemType: JOP_TYPE_TAG, changeType: CHANGE_DELETED, jopId: tag.jop_id, userId, changeItemType: 2 });
        return { content: [{ type: "text" as const, text: `🗑️ Tag supprimé !\n🏷️ ${parsedTag.title}\n🆔 ID: ${tag.id}\n💡 ${alive.length} assignation(s) retirée(s) ; les notes sont intactes.` }] };
      } catch (e: any) { return { content: [{ type: "text" as const, text: `Erreur: ${e.message}` }] }; }
    }
  );

  return server;
}

async function main() {
  try {
    const client = await pool.connect();
    console.log("✅ Connected to Joplin PostgreSQL database");
    client.release();
  } catch (e) {
    console.error("❌ Failed to connect to database:", e);
    process.exit(1);
  }

  const app = express();

  // Middleware d'authentification MCP
  if (MCP_API_KEY) {
    app.use((req, res, next) => {
      // Exclure les endpoints publics (health, root)
      if (req.path === "/health" || req.path === "/") {
        return next();
      }
      const authHeader = req.headers.authorization || "";
      if (!authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Missing or invalid Authorization header" });
      }
      const providedKey = authHeader.split("Bearer ")[1].trim();
      if (providedKey !== MCP_API_KEY) {
        return res.status(401).json({ error: "Invalid API key" });
      }
      next();
    });
  }

  // Debug logging
  app.use((req, _res, next) => {
    console.log(`📨 ${req.method} ${req.url} Host=${req.headers.host || "none"}`);
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", endpoints: ["/health", "/sse", "/messages", "/mcp", "/files"] });
  });

  app.get("/", (_req, res) => {
    res.json({ status: "ok", service: "joplin-mcp", endpoints: ["/health", "/sse", "/messages", "/mcp", "/files"] });
  });

  // Streamable HTTP transport - express.json() parses body, pass it as 3rd arg to SDK
  const sessions: Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }> = new Map();

  app.post("/mcp", express.json({ limit: MCP_JSON_LIMIT }), async (req, res) => {
    console.log(`🔌 POST /mcp body keys: ${Object.keys(req.body || {}).join(",")}`);
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let entry: { transport: StreamableHTTPServerTransport; server: McpServer };

      if (sessionId && sessions.has(sessionId)) {
        entry = sessions.get(sessionId)!;
      } else {
        const mcpServer = createMcpServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        entry = { transport, server: mcpServer };
        const sid = transport.sessionId || crypto.randomUUID();
        sessions.set(sid, entry);
        transport.onclose = () => {
          console.log(`🔌 Session ${sid} closed`);
          sessions.delete(sid);
        };
        await mcpServer.connect(transport);
      }

      // Pass req.body as 3rd argument so SDK doesn't try to re-read the consumed stream
      await entry.transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("Streamable HTTP error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  });

  app.get("/mcp", (_req, res) => {
    res.status(405).json({ error: "Method not allowed. Use POST." });
  });

  app.delete("/mcp", (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId && sessions.has(sessionId)) {
      const entry = sessions.get(sessionId)!;
      entry.transport.close();
      sessions.delete(sessionId);
      res.status(200).json({ status: "ok" });
    } else {
      res.status(404).json({ error: "Session not found" });
    }
  });

  // ====== BINARY ATTACHMENT TRANSFER (same Bearer auth as /mcp) ======

  app.get("/files/:id", async (req, res) => {
    try {
      const userId = await getUserId();
      const row = await findItem(String(req.params.id), JOP_TYPE_RESOURCE, userId);
      if (!row) { res.status(404).json({ error: "Resource not found" }); return; }
      const summary = resourceSummary(row);
      const blob = await findResourceBlob(row.jop_id, userId);
      if (!blob) { res.status(404).json({ error: "Resource content not found" }); return; }
      const extension = summary.fileExtension;
      const filename = extension && !summary.title.toLowerCase().endsWith(`.${extension}`) ? `${summary.title}.${extension}` : summary.title;
      res.setHeader("Content-Type", summary.mime || "application/octet-stream");
      res.setHeader("Content-Length", String(blob.content.length));
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
      res.end(blob.content);
    } catch (e: any) {
      console.error("GET /files error:", e);
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });

  app.post("/files", express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }), async (req, res) => {
    try {
      const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const filename = String(req.query.filename || (req.headers["x-filename"] as string) || "").trim();
      if (!filename) { res.status(400).json({ error: "Missing filename: pass ?filename=<name.ext> or the X-Filename header" }); return; }
      if (data.length === 0) { res.status(400).json({ error: "Empty request body" }); return; }
      const userId = await getUserId();
      let note: JoplinItemRow | null = null;
      const noteId = req.query.note_id ? String(req.query.note_id) : "";
      if (noteId) {
        note = await findItem(noteId, JOP_TYPE_NOTE, userId);
        if (!note) { res.status(404).json({ error: `Note '${noteId}' not found` }); return; }
      }
      const contentType = String(req.headers["content-type"] || "").split(";")[0].trim();
      const mime = req.query.mime ? String(req.query.mime) : contentType;
      const title = req.query.title ? String(req.query.title) : filename;
      const asImageFlag = String(req.query.as_image || "").toLowerCase();
      const asImage = asImageFlag === "1" || asImageFlag === "true";
      const resource = await createResource({ title, data, mime, userId });
      if (note) await appendResourceLinkToNote(note, resource.title, resource.jopId, asImage);
      res.status(201).json({
        ok: true,
        id: resource.id,
        jop_id: resource.jopId,
        title: resource.title,
        mime: resource.mime,
        size: resource.size,
        note_id: note ? note.id : null,
        link: buildResourceLink(resource.title, resource.jopId, asImage),
        download_url: `${MCP_PUBLIC_URL}/files/${resource.id}`
      });
    } catch (e: any) {
      console.error("POST /files error:", e);
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });

  app.put("/files/:id", express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }), async (req, res) => {
    try {
      const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (data.length === 0) { res.status(400).json({ error: "Empty request body" }); return; }
      const userId = await getUserId();
      const row = await findItem(String(req.params.id), JOP_TYPE_RESOURCE, userId);
      if (!row) { res.status(404).json({ error: "Resource not found" }); return; }
      const summary = resourceSummary(row);
      if (summary.isDeleted) { res.status(409).json({ error: "Resource is in the trash: restore it first" }); return; }
      const filename = String(req.query.filename || (req.headers["x-filename"] as string) || "").trim() || undefined;
      const contentType = String(req.headers["content-type"] || "").split(";")[0].trim();
      const mime = req.query.mime ? String(req.query.mime) : contentType || undefined;
      const result = await replaceResourceContent({ resource: row, data, mime, filename, userId });
      res.json({
        ok: true,
        id: result.id,
        jop_id: result.jopId,
        title: result.title,
        mime: result.mime,
        size: result.size,
        previous_size: result.sizeBefore,
        download_url: `${MCP_PUBLIC_URL}/files/${result.id}`
      });
    } catch (e: any) {
      console.error("PUT /files error:", e);
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });

  // JSON body parser for other routes AFTER /mcp
  app.use(express.json());

  // SSE transport
  app.get("/sse", (req, res) => {
    console.log("📡 SSE connection request received");
    const mcpServer = createMcpServer();
    const transport = new SSEServerTransport("/messages", res);
    transport.onclose = () => { console.log("📡 SSE session closed"); };
    mcpServer.connect(transport).catch((err: Error) => { console.error("SSE connection error:", err); });
  });

  app.post("/messages", (_req, res) => {
    res.status(400).send("Use SSE transport for messages");
  });

  app.listen(MCP_PORT, "0.0.0.0", () => {
    console.log(`✅ Joplin MCP Server listening on 0.0.0.0:${MCP_PORT}`);
    console.log(`   SSE endpoint: http://0.0.0.0:${MCP_PORT}/sse`);
    console.log(`   Streamable HTTP endpoint: http://0.0.0.0:${MCP_PORT}/mcp`);
    console.log(`   Health check: http://0.0.0.0:${MCP_PORT}/health`);
    console.log(`   Attachment transfer: http://0.0.0.0:${MCP_PORT}/files`);
  });
}

main().catch((e) => { console.error("Fatal error:", e); process.exit(1); });