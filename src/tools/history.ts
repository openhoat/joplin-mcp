import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseJoplinContent, parseRawJson } from "../lib/content.js";
import { formatTimestamp } from "../lib/format.js";
import { renderHistoryDiff } from "../lib/history.js";
import { JOP_TYPE_NOTE, type JoplinItemRow } from "../lib/joplin-types.js";
import type { ToolDeps } from "./deps.js";

export function registerHistoryTools(server: McpServer, deps: ToolDeps): void {
  const { store } = deps;

  server.tool(
    "list_conflicted_notes",
    "List the notes Joplin flagged as sync conflicts (`is_conflict`), most recently updated first. Useful to triage what a sync clash left behind; resolve by merging the bodies with `update_note`.",
    { limit: z.number().default(20).describe("Max notes to return") },
    async ({ limit }) => {
      try {
        const userId = await store.resolveUserId();
        const rows = await store.listConflictedNotes(userId, limit);
        const folderTitles = await store.listFolderTitles(userId);
        const notes = (rows as JoplinItemRow[])
          .map((row) => {
            const parsed = parseJoplinContent(row.content);
            const json = parsed.json || {};
            return {
              id: row.id,
              title: parsed.title,
              deleted: parsed.isDeleted,
              originalId: String(json.conflict_original_id || ""),
              notebook: folderTitles.get(String(row.jop_parent_id)) || "",
              updated: Number(row.updated_time),
            };
          })
          .filter((n) => !n.deleted);
        if (notes.length === 0) return { content: [{ type: "text" as const, text: "No note in conflict." }] };
        const lines = notes.map(
          (n) =>
            `**${n.title}**\n   ID: ${n.id}${n.notebook ? ` · notebook: ${n.notebook}` : ""} · updated ${formatTimestamp(n.updated)}${n.originalId ? ` · original: ${n.originalId}` : ""}`,
        );
        return { content: [{ type: "text" as const, text: `Notes in conflict (${notes.length}):\n\n${lines.join("\n\n")}` }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  server.tool(
    "get_note_history",
    "Read the server-side note history: every recorded change entry for a note (when, which metadata fields changed, title and body edits). Read-only — to roll back, take the text from an entry and call `update_note`.",
    {
      note_id: z.string().describe("The ID of the note (MCP id or Joplin 32-hex id)"),
      limit: z.number().default(10).describe("Max history entries, most recent first"),
    },
    async ({ note_id, limit }) => {
      try {
        const userId = await store.resolveUserId();
        const note = await store.findItem(note_id, JOP_TYPE_NOTE, userId);
        if (!note) return { content: [{ type: "text" as const, text: `Note '${note_id}' not found.` }], isError: true };
        const rows = await store.listHistoryEntries(userId, note.jop_id);
        const entries = rows
          .map((row: any) => {
            const json = parseRawJson(row.content);
            return {
              at: Number(json.item_updated_time || row.updated_time),
              metadata: json.metadata_diff,
              title: json.title_diff,
              body: json.body_diff,
            };
          })
          .filter((entry: any) => Number(entry.at) > 0)
          .sort((a: any, b: any) => b.at - a.at)
          .slice(0, Math.min(limit, 100));
        if (entries.length === 0) {
          return { content: [{ type: "text" as const, text: `No server history for "${parseJoplinContent(note.content).title}".` }] };
        }
        const blocks = entries.map((entry: any) => {
          const lines: string[] = [`${formatTimestamp(entry.at)}`];
          // metadata_diff is stored as a JSON string, the two other diffs as JSON arrays
          let meta: any = entry.metadata;
          if (typeof meta === "string") {
            try {
              meta = JSON.parse(meta);
            } catch {
              meta = null;
            }
          }
          if (meta && typeof meta === "object") {
            const added = meta.new && typeof meta.new === "object" ? meta.new : {};
            const trashed = Number(added.deleted_time || 0) > 0;
            // The first history entry of an item dumps the whole record: no point listing 22 fields
            const isCreation = Boolean(added.id);
            const changed = Object.keys(added).filter((k) => !["user_created_time", "deleted_time"].includes(k));
            const removed = Array.isArray(meta.deleted) ? meta.deleted : [];
            if (trashed) lines.push("   moved to the trash");
            if (isCreation) {
              lines.push("   creation (initial state of the item)");
            } else if (changed.length) {
              lines.push(`   fields: ${changed.slice(0, 8).join(", ")}${changed.length > 8 ? ` … (${changed.length} total)` : ""}`);
            }
            if (removed.length) lines.push(`   removed: ${removed.join(", ")}`);
          }
          const titleDiff = renderHistoryDiff(entry.title);
          if (titleDiff.length) lines.push(`   title: ${titleDiff.slice(0, 3).join(" | ")}`);
          const bodyDiff = renderHistoryDiff(entry.body);
          if (bodyDiff.length)
            lines.push(
              `   body:\n${bodyDiff
                .slice(0, 6)
                .map((l: string) => `     ${l}`)
                .join("\n")}`,
            );
          return lines.join("\n");
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `History of "${parseJoplinContent(note.content).title}" (${entries.length} entries):\n\n${blocks.join("\n\n")}`,
            },
          ],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  );
}
