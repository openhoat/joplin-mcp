#!/usr/bin/env node

/**
 * Joplin MCP Server - Access Joplin notes via PostgreSQL direct access.
 * Uses the official MCP SDK with per-connection server instances.
 * Supports Joplin v3 JSON content format.
 *
 * This file is the composition root: configuration, store assembly, tool
 * registration and the HTTP surface. The database lives behind `src/store`, the
 * tool handlers behind `src/tools/<domain>.ts`.
 */

import * as crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { MAX_UPLOAD_BYTES, MCP_JSON_LIMIT, readServerConfig } from "./config.js";
import { JOP_TYPE_NOTE, JOP_TYPE_RESOURCE } from "./lib/joplin-types.js";
import { buildResourceLink } from "./lib/markdown.js";
import { resourceSummary } from "./lib/resource.js";
import { createPool, readDbConfig } from "./store/connection.js";
import { createStore, type Store } from "./store/index.js";
import { registerAttachmentTools } from "./tools/attachments.js";
import type { ToolDeps } from "./tools/deps.js";
import { registerHistoryTools } from "./tools/history.js";
import { registerNotebookTools } from "./tools/notebooks.js";
import { registerNoteTools } from "./tools/notes.js";
import { registerTagTools } from "./tools/tags.js";
import { registerTrashTools } from "./tools/trash.js";

const VERSION = "1.14.0";

function createMcpServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: "joplin", version: VERSION });

  registerNoteTools(server, deps);
  registerNotebookTools(server, deps);
  registerAttachmentTools(server, deps);
  registerTagTools(server, deps);
  registerHistoryTools(server, deps);
  registerTrashTools(server, deps);

  return server;
}

/**
 * Build the Express app around the store.
 *
 * `/health` and `/` are public probes; every other route is behind the Bearer
 * token, compared through SHA-256 digests because `timingSafeEqual` needs equal
 * lengths (and the digest hides the key length from a timing observer).
 */
function createApp(deps: ToolDeps, config: { apiKey: string; publicUrl: string }): express.Express {
  const { store } = deps;
  const app = express();
  const apiKeyDigest = crypto.createHash("sha256").update(config.apiKey).digest();

  app.use((req, res, next) => {
    if (req.path === "/health" || req.path === "/") {
      return next();
    }
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing or invalid Authorization header" });
    }
    const providedKey = authHeader.slice("Bearer ".length).trim();
    const providedDigest = crypto.createHash("sha256").update(providedKey).digest();
    if (!crypto.timingSafeEqual(providedDigest, apiKeyDigest)) {
      return res.status(401).json({ error: "Invalid API key" });
    }
    next();
  });

  // Debug logging
  app.use((req, _res, next) => {
    console.log(`[http] ${req.method} ${req.url} host=${req.headers.host || "none"}`);
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
    console.log(`[mcp] POST /mcp body keys: ${Object.keys(req.body || {}).join(",")}`);
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let entry: { transport: StreamableHTTPServerTransport; server: McpServer };

      const existing = sessionId ? sessions.get(sessionId) : undefined;
      if (existing) {
        entry = existing;
      } else {
        const mcpServer = createMcpServer(deps);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        entry = { transport, server: mcpServer };
        const sid = transport.sessionId || crypto.randomUUID();
        sessions.set(sid, entry);
        transport.onclose = () => {
          console.log(`[mcp] session ${sid} closed`);
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
    const entry = sessionId ? sessions.get(sessionId) : undefined;
    if (sessionId && entry) {
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
      const userId = await store.resolveUserId();
      const row = await store.findItem(String(req.params.id), JOP_TYPE_RESOURCE, userId);
      if (!row) {
        res.status(404).json({ error: "Resource not found" });
        return;
      }
      const summary = resourceSummary(row);
      const blob = await store.findResourceBlob(row.jop_id, userId);
      if (!blob) {
        res.status(404).json({ error: "Resource content not found" });
        return;
      }
      const extension = summary.fileExtension;
      const filename =
        extension && !summary.title.toLowerCase().endsWith(`.${extension}`) ? `${summary.title}.${extension}` : summary.title;
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
      if (!filename) {
        res.status(400).json({ error: "Missing filename: pass ?filename=<name.ext> or the X-Filename header" });
        return;
      }
      if (data.length === 0) {
        res.status(400).json({ error: "Empty request body" });
        return;
      }
      const userId = await store.resolveUserId();
      let note: Awaited<ReturnType<Store["findItem"]>> = null;
      const noteId = req.query.note_id ? String(req.query.note_id) : "";
      if (noteId) {
        note = await store.findItem(noteId, JOP_TYPE_NOTE, userId);
        if (!note) {
          res.status(404).json({ error: `Note '${noteId}' not found` });
          return;
        }
      }
      const contentType = String(req.headers["content-type"] || "")
        .split(";")[0]
        .trim();
      const mime = req.query.mime ? String(req.query.mime) : contentType;
      const title = req.query.title ? String(req.query.title) : filename;
      const asImageFlag = String(req.query.as_image || "").toLowerCase();
      const asImage = asImageFlag === "1" || asImageFlag === "true";
      const resource = await store.createResource({ title, data, mime, userId });
      if (note) await store.appendResourceLinkToNote(note, resource.title, resource.jopId, asImage);
      res.status(201).json({
        ok: true,
        id: resource.id,
        jop_id: resource.jopId,
        title: resource.title,
        mime: resource.mime,
        size: resource.size,
        note_id: note ? note.id : null,
        link: buildResourceLink(resource.title, resource.jopId, asImage),
        download_url: `${config.publicUrl}/files/${resource.id}`,
      });
    } catch (e: any) {
      console.error("POST /files error:", e);
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });

  app.put("/files/:id", express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }), async (req, res) => {
    try {
      const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (data.length === 0) {
        res.status(400).json({ error: "Empty request body" });
        return;
      }
      const userId = await store.resolveUserId();
      const row = await store.findItem(String(req.params.id), JOP_TYPE_RESOURCE, userId);
      if (!row) {
        res.status(404).json({ error: "Resource not found" });
        return;
      }
      const summary = resourceSummary(row);
      if (summary.isDeleted) {
        res.status(409).json({ error: "Resource is in the trash: restore it first" });
        return;
      }
      const filename = String(req.query.filename || (req.headers["x-filename"] as string) || "").trim() || undefined;
      const contentType = String(req.headers["content-type"] || "")
        .split(";")[0]
        .trim();
      const mime = req.query.mime ? String(req.query.mime) : contentType || undefined;
      const result = await store.replaceResourceContent({ resource: row, data, mime, filename, userId });
      res.json({
        ok: true,
        id: result.id,
        jop_id: result.jopId,
        title: result.title,
        mime: result.mime,
        size: result.size,
        previous_size: result.sizeBefore,
        download_url: `${config.publicUrl}/files/${result.id}`,
      });
    } catch (e: any) {
      console.error("PUT /files error:", e);
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });

  // JSON body parser for other routes AFTER /mcp
  app.use(express.json());

  // SSE transport
  app.get("/sse", (_req, res) => {
    console.log("[sse] connection request received");
    const mcpServer = createMcpServer(deps);
    const transport = new SSEServerTransport("/messages", res);
    transport.onclose = () => {
      console.log("[sse] session closed");
    };
    mcpServer.connect(transport).catch((err: Error) => {
      console.error("SSE connection error:", err);
    });
  });

  app.post("/messages", (_req, res) => {
    res.status(400).send("Use SSE transport for messages");
  });

  return app;
}

async function main() {
  const config = readServerConfig();

  // Fail closed: this process reads and writes the notes database, it must never run unauthenticated
  if (!config.apiKey || config.apiKey.trim() === "" || config.apiKey === "change-me") {
    console.error("MCP_API_KEY is required and must be set to a real secret.");
    console.error("   This server reads and writes your Joplin database: it refuses to start without authentication.");
    console.error("   Generate one with: openssl rand -hex 32");
    process.exit(1);
  }

  const pool = createPool(readDbConfig());
  const store = createStore(pool, config.pinnedUserId);

  try {
    const client = await pool.connect();
    console.log("Connected to Joplin PostgreSQL database");
    client.release();
  } catch (e) {
    console.error("Failed to connect to database:", e);
    process.exit(1);
  }

  const app = createApp({ store, publicUrl: config.publicUrl }, config);

  app.listen(config.port, "0.0.0.0", () => {
    console.log(`joplin-mcp listening on 0.0.0.0:${config.port}`);
    console.log(`   SSE endpoint: http://0.0.0.0:${config.port}/sse`);
    console.log(`   Streamable HTTP endpoint: http://0.0.0.0:${config.port}/mcp`);
    console.log(`   Health check: http://0.0.0.0:${config.port}/health`);
    console.log(`   Attachment transfer: http://0.0.0.0:${config.port}/files`);
  });
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
