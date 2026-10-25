import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEFAULT_INLINE_DOWNLOAD_MAX_BYTES, HARD_INLINE_DOWNLOAD_MAX_BYTES } from "../config.js";
import { formatBytes } from "../lib/format.js";
import { JOP_TYPE_NOTE, JOP_TYPE_RESOURCE, type JoplinItemRow } from "../lib/joplin-types.js";
import { resourceSummary } from "../lib/resource.js";
import type { ToolDeps } from "./deps.js";
import { defineTool } from "./tool.js";

export function registerAttachmentTools(server: McpServer, deps: ToolDeps): void {
  const { store, publicUrl } = deps;

  defineTool(
    server,
    "list_note_attachments",
    "List the file attachments (resources) of a note. Returns resource IDs usable with `get_resource`, `download_resource`, `attach_resource_to_note` and `unlink_resource_from_note`.",
    {
      note_id: z.string().describe("The ID of the note (MCP id or Joplin 32-hex id)"),
      limit: z.number().default(50).describe("Max attachments to return"),
    },
    async ({ note_id, limit }) => {
      try {
        const userId = await store.resolveUserId();
        const note = await store.findItem(note_id, JOP_TYPE_NOTE, userId);
        if (!note) return { content: [{ type: "text" as const, text: `Note '${note_id}' not found.` }], isError: true };
        const resourceJopIds = await store.listNoteResourceIds(note);
        if (resourceJopIds.length === 0) return { content: [{ type: "text" as const, text: `Note '${note_id}' has no attachment.` }] };
        const rows = await store.listResourcesByJopIds(userId, Array.from(resourceJopIds), limit);
        const resources = (rows as JoplinItemRow[]).map(resourceSummary).filter((r) => !r.isDeleted);
        if (resources.length === 0) return { content: [{ type: "text" as const, text: `Note '${note_id}' has no available attachment.` }] };
        const lines = resources.map(
          (r) => `**${r.title}** (ID: ${r.id})\n   jop_id: ${r.jopId} · ${formatBytes(r.size)} · ${r.mime}\n   Updated: ${r.updated}`,
        );
        return { content: [{ type: "text" as const, text: `Attachments (${resources.length}):\n\n${lines.join("\n\n")}` }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  defineTool(
    server,
    "list_resources",
    "List the most recently updated file attachments (resources) across all notes. Returns resource IDs for `download_resource` / `attach_resource_to_note`.",
    {
      limit: z.number().default(20).describe("Max resources"),
      query: z.string().optional().describe("Optional text filter on the resource title"),
    },
    async ({ limit, query }) => {
      try {
        const userId = await store.resolveUserId();
        const rows = await store.listResources(userId, { query, limit });
        const resources = (rows as JoplinItemRow[]).map(resourceSummary).filter((r) => !r.isDeleted);
        if (resources.length === 0) return { content: [{ type: "text" as const, text: "No attachment found." }] };
        const lines = resources.map((r) => `**${r.title}** (ID: ${r.id})\n   ${formatBytes(r.size)} · ${r.mime} · ${r.updated}`);
        return { content: [{ type: "text" as const, text: `Recent attachments (${resources.length}):\n\n${lines.join("\n\n")}` }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  defineTool(
    server,
    "get_resource",
    "Get the metadata of a file attachment (resource): title, MIME type, size, blob presence and the notes that reference it. Use `download_resource` for the bytes.",
    { resource_id: z.string().describe("The resource ID (MCP id or Joplin 32-hex id)") },
    async ({ resource_id }) => {
      try {
        const userId = await store.resolveUserId();
        const row = await store.findItem(resource_id, JOP_TYPE_RESOURCE, userId);
        if (!row) return { content: [{ type: "text" as const, text: `Resource '${resource_id}' not found.` }], isError: true };
        const summary = resourceSummary(row);
        const blob = await store.findResourceBlob(row.jop_id, userId);
        const usage = await store.listResourceLinks(row.jop_id);
        const text = [
          `${summary.isDeleted ? "[trashed] " : ""}**${summary.title}**`,
          `ID: ${summary.id}`,
          `jop_id: ${summary.jopId}`,
          `Size: ${formatBytes(summary.size)}`,
          `Type: ${summary.mime}${summary.fileExtension ? ` (.${summary.fileExtension})` : ""}`,
          `Updated: ${summary.updated}`,
          `Blob: ${blob ? `${formatBytes(blob.content_size)} stored` : "missing"}`,
          `Referenced by ${usage.length} note(s)`,
          `Download: ${publicUrl}/files/${summary.id} (Authorization: Bearer <MCP key> header)`,
        ].join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  defineTool(
    server,
    "download_resource",
    "Download a file attachment (resource) and return its bytes as base64. Inline output is capped (default 10 MiB, max 32 MiB); for bigger files use the GET /files/<id> endpoint of this server instead.",
    {
      resource_id: z.string().describe("The resource ID (MCP id or Joplin 32-hex id)"),
      max_bytes: z
        .number()
        .optional()
        .describe(`Inline size cap in bytes (default ${DEFAULT_INLINE_DOWNLOAD_MAX_BYTES}, max ${HARD_INLINE_DOWNLOAD_MAX_BYTES})`),
    },
    async ({ resource_id, max_bytes }) => {
      try {
        const userId = await store.resolveUserId();
        const row = await store.findItem(resource_id, JOP_TYPE_RESOURCE, userId);
        if (!row) return { content: [{ type: "text" as const, text: `Resource '${resource_id}' not found.` }], isError: true };
        const summary = resourceSummary(row);
        if (summary.isDeleted)
          return { content: [{ type: "text" as const, text: `Resource '${resource_id}' is in the trash.` }], isError: true };
        const blob = await store.findResourceBlob(row.jop_id, userId);
        if (!blob)
          return { content: [{ type: "text" as const, text: `No binary content for resource '${resource_id}' (${summary.title}).` }] };
        const cap = Math.min(max_bytes ?? DEFAULT_INLINE_DOWNLOAD_MAX_BYTES, HARD_INLINE_DOWNLOAD_MAX_BYTES);
        if (blob.content.length > cap) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `File too large for an inline reply (${formatBytes(blob.content.length)} > ${formatBytes(cap)}).\n` +
                  `Use the binary endpoint:\n` +
                  `curl -fsSL -H "Authorization: Bearer $JOPLIN_API_KEY" "${publicUrl}/files/${summary.id}" -o "${summary.title}"`,
              },
            ],
            isError: true,
          };
        }
        const header = `**${summary.title}**\nID: ${summary.id} · jop_id: ${summary.jopId}\n${summary.mime} · ${formatBytes(blob.content.length)}\nBase64 (${summary.fileExtension || "bin"}):`;
        return { content: [{ type: "text" as const, text: `${header}\n${blob.content.toString("base64")}` }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  defineTool(
    server,
    "add_resource",
    "Attach a file to a note from inline base64 content (small files only, max 32 MiB). Creates the Joplin resource (metadata + binary blob) and, when note_id is provided, appends the markdown link to the note. For bigger files use the POST /files endpoint of this server.",
    {
      filename: z.string().describe("File name including extension (used as the resource title)"),
      data_base64: z.string().describe("File content encoded in base64 (data: URL prefix accepted)"),
      note_id: z.string().optional().describe("Optional note ID to attach the new resource to"),
      mime_type: z.string().optional().describe("Optional MIME type (guessed from the extension when omitted)"),
      as_image: z.boolean().optional().describe("Insert an image link (![...]) instead of a file link"),
    },
    async ({ filename, data_base64, note_id, mime_type, as_image }) => {
      try {
        const userId = await store.resolveUserId();
        const cleaned = data_base64.replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
        const data = Buffer.from(cleaned, "base64");
        if (data.length === 0)
          return { content: [{ type: "text" as const, text: "Error: empty or invalid base64 content." }], isError: true };
        if (data.length > HARD_INLINE_DOWNLOAD_MAX_BYTES) {
          return {
            content: [
              {
                type: "text" as const,
                text: `File too large for an inline upload (${formatBytes(data.length)} > ${formatBytes(HARD_INLINE_DOWNLOAD_MAX_BYTES)}). Use POST /files.`,
              },
            ],
            isError: true,
          };
        }
        let note: JoplinItemRow | null = null;
        if (note_id) {
          note = await store.findItem(note_id, JOP_TYPE_NOTE, userId);
          if (!note) return { content: [{ type: "text" as const, text: `Note '${note_id}' not found.` }], isError: true };
        }
        const resource = await store.createResource({ title: filename, data, mime: mime_type, userId });
        let attachNote = "";
        if (note) {
          await store.appendResourceLinkToNote(note, resource.title, resource.jopId, as_image === true);
          attachNote = `\nAttached to note: ${note.id}`;
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Attachment created: **${resource.title}**\nID: ${resource.id}\njop_id: ${resource.jopId}\n${formatBytes(resource.size)} · ${resource.mime}${attachNote}`,
            },
          ],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  defineTool(
    server,
    "attach_resource_to_note",
    "Append a markdown link to an existing resource (attachment) into a note body. The resource must already exist (see `list_resources` / `add_resource`). Idempotent at the note body level: check `list_note_attachments` first if unsure.",
    {
      note_id: z.string().describe("The ID of the target note"),
      resource_id: z.string().describe("The resource ID (MCP id or Joplin 32-hex id)"),
      label: z.string().optional().describe("Optional link label (defaults to the resource title)"),
      as_image: z.boolean().optional().describe("Insert an image link (![...]) instead of a file link"),
    },
    async ({ note_id, resource_id, label, as_image }) => {
      try {
        const userId = await store.resolveUserId();
        const note = await store.findItem(note_id, JOP_TYPE_NOTE, userId);
        if (!note) return { content: [{ type: "text" as const, text: `Note '${note_id}' not found.` }], isError: true };
        const resource = await store.findItem(resource_id, JOP_TYPE_RESOURCE, userId);
        if (!resource) return { content: [{ type: "text" as const, text: `Resource '${resource_id}' not found.` }], isError: true };
        const summary = resourceSummary(resource);
        if (summary.isDeleted)
          return { content: [{ type: "text" as const, text: `Resource '${resource_id}' is in the trash.` }], isError: true };
        await store.appendResourceLinkToNote(note, label || summary.title, resource.jop_id, as_image === true);
        return { content: [{ type: "text" as const, text: `Attachment linked: **${summary.title}**\nNote: ${note.id}` }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  defineTool(
    server,
    "unlink_resource_from_note",
    "Remove the markdown links pointing at a resource from a note body. The resource itself is kept (it can stay attached to other notes or be downloaded later).",
    {
      note_id: z.string().describe("The ID of the note"),
      resource_id: z.string().describe("The resource ID (MCP id or Joplin 32-hex id)"),
    },
    async ({ note_id, resource_id }) => {
      try {
        const userId = await store.resolveUserId();
        const note = await store.findItem(note_id, JOP_TYPE_NOTE, userId);
        if (!note) return { content: [{ type: "text" as const, text: `Note '${note_id}' not found.` }], isError: true };
        const resource = await store.findItem(resource_id, JOP_TYPE_RESOURCE, userId);
        if (!resource) return { content: [{ type: "text" as const, text: `Resource '${resource_id}' not found.` }], isError: true };
        const removed = await store.removeResourceLinksFromNote(note, resource.jop_id);
        const summary = resourceSummary(resource);
        return {
          content: [
            {
              type: "text" as const,
              text:
                removed > 0
                  ? `Link removed (${removed} occurrence(s)).\nAttachment: ${summary.title}\nNote: ${note.id}\nThe resource still exists in Joplin.`
                  : `No link to '${summary.title}' in note ${note.id}.`,
            },
          ],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  defineTool(
    server,
    "delete_resource",
    "Delete a file attachment (resource): soft delete to the Joplin trash, same semantics as delete_note. The binary blob stays on the server until the trash is emptied from a client. Refuses when the resource is still linked from notes unless `force` is set (note bodies would keep dangling links).",
    {
      resource_id: z.string().describe("The resource ID (MCP id or Joplin 32-hex id)"),
      force: z.boolean().optional().describe("Delete even when still referenced by notes"),
    },
    async ({ resource_id, force }) => {
      try {
        const userId = await store.resolveUserId();
        const row = await store.findItem(resource_id, JOP_TYPE_RESOURCE, userId);
        if (!row) return { content: [{ type: "text" as const, text: `Resource '${resource_id}' not found.` }], isError: true };
        const summary = resourceSummary(row);
        if (summary.isDeleted)
          return { content: [{ type: "text" as const, text: `Resource '${summary.title}' is already in the trash.` }], isError: true };
        const refs = await store.listResourceLinks(row.jop_id);
        if (refs.length > 0 && force !== true) {
          const titles = await store.listNoteTitles(refs);
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Resource '${summary.title}' is still referenced by ${refs.length} note(s): ${titles.join(", ")}.\n` +
                  `Run unlink_resource_from_note first, or retry with force=true.`,
              },
            ],
            isError: true,
          };
        }
        await store.softDeleteResource(row, userId);
        const linksNote = refs.length > 0 ? `\n${refs.length} link(s) remain in note bodies (they render as a missing attachment).` : "";
        return {
          content: [
            {
              type: "text" as const,
              text: `Attachment moved to the trash: **${summary.title}**\nID: ${summary.id}\nThe binary stays on the server until the trash is purged.${linksNote}`,
            },
          ],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  defineTool(
    server,
    "update_resource",
    "Replace the binary content of an existing attachment (new version of a file). Ids are preserved, so every link already present in note bodies keeps working. Inline base64 only (max 32 MiB); for bigger files use `PUT /files/<id>` with the raw body.",
    {
      resource_id: z.string().describe("The resource ID (MCP id or Joplin 32-hex id)"),
      data_base64: z.string().describe("New file content encoded in base64 (data: URL prefix accepted)"),
      filename: z.string().optional().describe("Optional new file name (updates the resource title and extension)"),
      mime_type: z.string().optional().describe("Optional MIME type (guessed from the file name when omitted)"),
    },
    async ({ resource_id, data_base64, filename, mime_type }) => {
      try {
        const userId = await store.resolveUserId();
        const row = await store.findItem(resource_id, JOP_TYPE_RESOURCE, userId);
        if (!row) return { content: [{ type: "text" as const, text: `Attachment '${resource_id}' not found.` }], isError: true };
        const summary = resourceSummary(row);
        if (summary.isDeleted)
          return {
            content: [
              {
                type: "text" as const,
                text: `"${summary.title}" is in the trash: restore it with restore_item before replacing its content.`,
              },
            ],
            isError: true,
          };
        const cleaned = data_base64.replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
        const data = Buffer.from(cleaned, "base64");
        if (data.length === 0)
          return { content: [{ type: "text" as const, text: "Error: empty or invalid base64 content." }], isError: true };
        if (data.length > HARD_INLINE_DOWNLOAD_MAX_BYTES) {
          return {
            content: [
              {
                type: "text" as const,
                text: `File too large for an inline replacement (${formatBytes(data.length)} > ${formatBytes(HARD_INLINE_DOWNLOAD_MAX_BYTES)}). Use PUT /files/${summary.id}.`,
              },
            ],
            isError: true,
          };
        }
        const result = await store.replaceResourceContent({ resource: row, data, mime: mime_type, filename, userId });
        return {
          content: [
            {
              type: "text" as const,
              text: `Content replaced: **${result.title}**\nID: ${result.id}\njop_id: ${result.jopId} (unchanged, so note links stay valid)\n${formatBytes(result.sizeBefore)} → ${formatBytes(result.size)} · ${result.mime}`,
            },
          ],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  );
}
