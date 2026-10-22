import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseRawJson } from "../lib/content.js";
import { formatBytes, formatTimestamp } from "../lib/format.js";
import { JOP_TYPE_NOTE, JOP_TYPE_RESOURCE, type JoplinItemRow } from "../lib/joplin-types.js";
import type { ToolDeps } from "./deps.js";

export function registerTrashTools(server: McpServer, deps: ToolDeps): void {
  const { store } = deps;

  server.tool(
    "list_trash",
    "List the items currently sitting in the Joplin trash: notes and resources deleted but not purged. Use `restore_item` to bring one back.",
    {
      kind: z.enum(["all", "notes", "resources"]).default("all").describe("Restrict the listing to notes, resources, or both"),
      limit: z.number().default(50).describe("Max items to return"),
    },
    async ({ kind, limit }) => {
      try {
        const userId = await store.resolveUserId();
        const types = kind === "notes" ? [JOP_TYPE_NOTE] : kind === "resources" ? [JOP_TYPE_RESOURCE] : [JOP_TYPE_NOTE, JOP_TYPE_RESOURCE];
        const rows = await store.listTrashed(userId, types, limit);
        const items = (rows as JoplinItemRow[])
          .map((row) => {
            const json = parseRawJson(row.content);
            return {
              id: row.id,
              jopId: row.jop_id,
              type: row.jop_type === JOP_TYPE_NOTE ? "note" : "resource",
              title: String(json.title || "(untitled)"),
              deletedAt: formatTimestamp(Number(json.deleted_time || 0)),
              size: Number(json.size || 0),
            };
          })
          .filter((i) => i.deletedAt !== "N/A");
        if (items.length === 0) return { content: [{ type: "text" as const, text: "The trash is empty." }] };
        const lines = items.map(
          (i) =>
            `**${i.title}** (${i.type})\n   ID: ${i.id} · jop_id: ${i.jopId} · deleted ${i.deletedAt}${i.type === "resource" ? ` · ${formatBytes(i.size)}` : ""}`,
        );
        return { content: [{ type: "text" as const, text: `Trash (${items.length}):\n\n${lines.join("\n\n")}` }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  server.tool(
    "restore_item",
    "Restore an item from the Joplin trash (note or resource): clears deleted_time and records an update so synced clients bring it back. The original ids (and therefore the note links) are preserved.",
    { item_id: z.string().describe("The note or resource ID (MCP id or Joplin 32-hex id)") },
    async ({ item_id }) => {
      try {
        const userId = await store.resolveUserId();
        const row = (await store.findItem(item_id, JOP_TYPE_NOTE, userId)) || (await store.findItem(item_id, JOP_TYPE_RESOURCE, userId));
        if (!row)
          return {
            content: [{ type: "text" as const, text: `Item '${item_id}' not found (neither a note nor a resource).` }],
            isError: true,
          };
        const json = parseRawJson(row.content);
        const title = String(json.title || "(untitled)");
        if (!(Number(json.deleted_time || 0) > 0)) {
          return { content: [{ type: "text" as const, text: `"${title}" is not in the trash.` }], isError: true };
        }
        await store.restore(row, userId);
        const kindLabel = row.jop_type === JOP_TYPE_NOTE ? "Note" : "Attachment";
        return { content: [{ type: "text" as const, text: `${kindLabel} restored: **${title}**\nID: ${row.id}` }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  );
}
