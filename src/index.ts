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

const JOP_TYPE_NOTE = 1;
const JOP_TYPE_FOLDER = 2;

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

function formatTimestamp(tsMs: number): string {
  if (!tsMs) return "N/A";
  try { return new Date(tsMs).toISOString().replace("T", " ").substring(0, 19); }
  catch { return String(tsMs); }
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
  itemType: number;  // jop_type from items (1=note, 2=folder)
  changeType: number; // CHANGE_CREATED, CHANGE_UPDATED, CHANGE_DELETED
  jopId: string;
  userId: string;
}): Promise<void> {
  const { itemId, itemType, changeType, jopId, userId } = params;
  const changeId = generateId();
  const now = Date.now();
  const itemName = `${jopId}.md`;
  const changesItemType = jopTypeToChangeItemType(itemType);
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

function createMcpServer(): McpServer {
  const server = new McpServer({ name: "joplin", version: "1.1.1" });

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

  // ====== WRITE TOOLS ======

  server.tool("create_note", "Create a new note in Joplin. IMPORTANT: You MUST call this function to create a note. NEVER tell the user a note has been created without actually calling this function and receiving a success response. Use `search_notebooks` or `list_notebooks` first to find the notebook_id if the user specifies a notebook.",
    {
      title: z.string().describe("Note title"),
      body: z.string().describe("Note body in Markdown"),
      notebook_id: z.string().optional().describe("Optional notebook ID to place the note in")
    },
    async ({ title, body, notebook_id }) => {
      try {
        const userId = await getUserId();
        const noteId = generateId();
        const now = Date.now();
        const jopId = generateJopId();
        const contentBytes = buildNoteContent(title, body);
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
      body: z.string().optional().describe("New body content in Markdown (optional, keeps existing if not provided)")
    },
    async ({ note_id, title, body }) => {
      try {
        if (!title && !body) return { content: [{ type: "text" as const, text: "Erreur: fournis au moins un titre ou un contenu à modifier." }] };
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
        const contentBytes = buildNoteContent(newTitle, newBody, { ...extra, user_updated_time: now });
        await pool.query(
          `UPDATE items SET content = $1, content_size = $2, updated_time = $3, jop_updated_time = $4 WHERE id = $5`,
          [contentBytes, contentBytes.length, now, now, note_id]
        );
        // Record change so Joplin Server pushes the update to synced clients
        const userId = await getUserId();
        const jopIdResult = await pool.query(`SELECT jop_id FROM items WHERE id = $1`, [note_id]);
        const jopId = jopIdResult.rows.length > 0 ? jopIdResult.rows[0].jop_id : note_id;
        await recordChange({ itemId: note_id, itemType: JOP_TYPE_NOTE, changeType: CHANGE_UPDATED, jopId: jopId, userId });
        return { content: [{ type: "text" as const, text: `✅ Note mise à jour !\n📝 Titre: ${newTitle}\n🆔 ID: ${note_id}` }] };
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
        await recordChange({ itemId: note_id, itemType: JOP_TYPE_NOTE, changeType: CHANGE_UPDATED, jopId, userId });
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
    res.json({ status: "ok", endpoints: ["/health", "/sse", "/messages", "/mcp"] });
  });

  app.get("/", (_req, res) => {
    res.json({ status: "ok", service: "joplin-mcp", endpoints: ["/health", "/sse", "/messages", "/mcp"] });
  });

  // Streamable HTTP transport - express.json() parses body, pass it as 3rd arg to SDK
  const sessions: Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }> = new Map();

  app.post("/mcp", express.json(), async (req, res) => {
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
  });
}

main().catch((e) => { console.error("Fatal error:", e); process.exit(1); });