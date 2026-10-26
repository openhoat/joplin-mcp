import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildIconString, parseJoplinContent } from "../lib/content.js";
import { formatTimestamp } from "../lib/format.js";
import { JOP_TYPE_FOLDER } from "../lib/joplin-types.js";
import type { ToolDeps } from "./deps.js";
import { CREATING, DESTRUCTIVE, defineTool, MUTATING, READ_ONLY } from "./tool.js";

export function registerNotebookTools(server: McpServer, deps: ToolDeps): void {
  const { store } = deps;

  defineTool(
    server,
    "search_notebooks",
    "Search for notebooks by name. Returns notebook IDs. WORKFLOW: Use the returned notebook_id with `list_notes_in_notebook` to see its notes, or with `create_note` to create a note inside it.",
    READ_ONLY,
    {
      query: z.string().describe("The search text to find in notebook titles"),
      limit: z.number().default(10).describe("Max results"),
    },
    async ({ query, limit }) => {
      try {
        const userId = await store.resolveUserId();
        const rows = await store.searchFolders(userId, query, limit);
        if (rows.length === 0) return { content: [{ type: "text" as const, text: `No notebook found for '${query}'.` }] };
        const notebooks = rows.map((row: any) => {
          const parsed = parseJoplinContent(row.content);
          return `**${parsed.title}** (ID: ${row.id})`;
        });
        return {
          content: [{ type: "text" as const, text: `Found ${notebooks.length} notebook(s) for '${query}':\n\n${notebooks.join("\n")}` }],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  defineTool(
    server,
    "list_notebooks",
    "List all notebooks. Returns notebook IDs. WORKFLOW: Use `list_notes_in_notebook` with a notebook_id to see the notes inside, or use the notebook_id with `create_note` to place a new note in it.",
    READ_ONLY,
    {},
    async () => {
      try {
        const userId = await store.resolveUserId();
        const rows = await store.listFolders(userId);
        if (rows.length === 0) return { content: [{ type: "text" as const, text: "No notebooks found." }] };
        const notebooks = rows.map((row: any) => {
          const parsed = parseJoplinContent(row.content);
          return `**${parsed.title}** (ID: ${row.id})`;
        });
        return { content: [{ type: "text" as const, text: `Notebooks (${rows.length}):\n\n${notebooks.join("\n")}` }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  defineTool(
    server,
    "list_notes_in_notebook",
    "List notes inside a specific notebook. Returns note IDs with SHORT PREVIEWS only. WORKFLOW: 1) Call this to list notes in a notebook. 2) Then call `get_note` with a note_id to read the FULL content. NEVER answer based only on the preview.",
    READ_ONLY,
    {
      notebook_id: z.string().describe("The ID of the notebook/folder"),
      limit: z.number().default(20).describe("Max notes to return"),
    },
    async ({ notebook_id, limit }) => {
      try {
        // The parent column stores the jop_id (32-hex), not the base62 id exposed by the MCP
        const folder = await store.findItem(notebook_id, JOP_TYPE_FOLDER, await store.resolveUserId());
        if (!folder)
          return {
            content: [
              { type: "text" as const, text: `Notebook '${notebook_id}' not found. Use list_notebooks to see the available notebooks.` },
            ],
            isError: true,
          };
        const folderParsed = parseJoplinContent(folder.content);
        const rows = await store.listNotesInFolder(folder.jop_id, limit);
        if (rows.length === 0) return { content: [{ type: "text" as const, text: `Notebook "${folderParsed.title}" has no notes.` }] };
        const notes = rows
          .map((row: any) => {
            const parsed = parseJoplinContent(row.content);
            const isTruncated = parsed.body.length > 100;
            return {
              id: row.id,
              title: parsed.title,
              preview: isTruncated ? parsed.body.substring(0, 100) : parsed.body,
              isTruncated,
              isDeleted: parsed.isDeleted,
              updated: formatTimestamp(row.updated_time),
            };
          })
          .filter((n: any) => !n.isDeleted);
        if (notes.length === 0) return { content: [{ type: "text" as const, text: `Notebook "${folderParsed.title}" has no notes.` }] };
        const lines = notes.map(
          (n: any) =>
            `**${n.title}** (ID: ${n.id})\n   ${n.updated} - ${n.preview}${n.isTruncated ? "\n   Preview truncated: call get_note with this ID to read the whole note" : ""}`,
        );
        return {
          content: [
            { type: "text" as const, text: `Notebook "${folderParsed.title}" - ${notes.length} note(s):\n\n${lines.join("\n\n")}` },
          ],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  defineTool(
    server,
    "get_notebook_tree",
    "Show the notebook hierarchy as an indented tree, with a note count per notebook. `list_notebooks` returns a flat list, which hides the parent links — use this one before creating or moving a notebook when nesting matters.",
    READ_ONLY,
    {},
    async () => {
      try {
        const userId = await store.resolveUserId();
        const rows = await store.listFolders(userId);
        const counts = await store.countNotesPerFolder(userId);
        const nodes = rows
          .map((row) => {
            const parsed = parseJoplinContent(row.content);
            return {
              id: row.id,
              jopId: String(row.jop_id),
              parent: String(row.jop_parent_id || ""),
              title: parsed.title,
              deleted: parsed.isDeleted,
            };
          })
          .filter((n) => !n.deleted);
        if (nodes.length === 0) return { content: [{ type: "text" as const, text: "No notebooks." }] };
        const byJop = new Map(nodes.map((n) => [n.jopId, n]));
        const children = new Map<string, typeof nodes>();
        const roots: typeof nodes = [];
        for (const node of nodes) {
          const parent = node.parent && byJop.has(node.parent) ? node.parent : "";
          if (!parent) {
            roots.push(node);
            continue;
          }
          const bucket = children.get(parent) || [];
          bucket.push(node);
          children.set(parent, bucket);
        }
        const lines: string[] = [];
        const walk = (list: typeof nodes, depth: number) => {
          for (const node of [...list].sort((a, b) => a.title.localeCompare(b.title))) {
            const count = counts.get(node.jopId) || 0;
            const branch = depth === 0 ? "" : `${"   ".repeat(depth - 1)}└─ `;
            lines.push(`${branch}${node.title} · ${count} note(s) · ID: ${node.id}`);
            walk(children.get(node.jopId) || [], depth + 1);
          }
        };
        walk(roots, 0);
        return { content: [{ type: "text" as const, text: `Notebooks (${nodes.length}):\n\n${lines.join("\n")}` }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  defineTool(
    server,
    "create_notebook",
    "Create a new notebook (folder) in Joplin. IMPORTANT: You MUST call this function to create a notebook. NEVER tell the user a notebook has been created without actually calling this function and receiving a success response.",
    CREATING,
    {
      title: z.string().describe("Notebook title"),
      parent_notebook_id: z.string().optional().describe("Optional parent notebook ID for sub-notebooks"),
      icon: z
        .object({
          emoji: z.string().describe('The emoji displayed as the notebook icon (e.g. "🏦")'),
          name: z.string().optional().describe('Optional icon name/label (e.g. "bank")'),
          type: z.number().optional().describe("Optional icon type (defaults to 1 = emoji)"),
        })
        .optional()
        .describe('Optional notebook icon, e.g. { emoji: "🏦", name: "bank" }'),
    },
    async ({ title, parent_notebook_id, icon }) => {
      try {
        const userId = await store.resolveUserId();
        // parent_notebook_id is the base62 'id' exposed by the MCP; the jop_parent_id column
        // stores the jop_id (32-hex UUID), so it MUST be translated first.
        let parentJopId = "";
        if (parent_notebook_id) {
          const parent = await store.findItem(parent_notebook_id, JOP_TYPE_FOLDER, userId);
          if (!parent) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Parent notebook '${parent_notebook_id}' not found. Use list_notebooks to find the parent id.`,
                },
              ],
              isError: true,
            };
          }
          parentJopId = parent.jop_id;
        }
        const folder = await store.createFolder({ title, parentJopId, icon: icon ? buildIconString(icon) : "", userId });
        return {
          content: [
            {
              type: "text" as const,
              text: `Notebook created: **${title}**${icon ? `\nIcon: ${icon.emoji}` : ""}\nID: ${folder.id}${parentJopId ? `\nSub-notebook of: ${parent_notebook_id}` : ""}`,
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
    "update_notebook",
    "Rename and/or set the icon of an existing notebook (folder) in Joplin. IMPORTANT: You MUST call this function to rename a notebook or change its icon. NEVER tell the user a notebook has been updated without actually calling this function and receiving a success response. Provide at least one of `title` or `icon`.",
    MUTATING,
    {
      notebook_id: z.string().describe("The ID of the notebook to update"),
      title: z.string().optional().describe("New notebook title (optional, keeps existing if not provided)"),
      icon: z
        .object({
          emoji: z.string().describe('The emoji displayed as the notebook icon (e.g. "🤖")'),
          name: z.string().optional().describe('Optional icon name/label (e.g. "robot")'),
          type: z.number().optional().describe("Optional icon type (defaults to 1 = emoji)"),
        })
        .optional()
        .describe('Optional notebook icon, e.g. { emoji: "🤖", name: "robot" }'),
    },
    async ({ notebook_id, title, icon }) => {
      try {
        if (title === undefined && icon === undefined) {
          return { content: [{ type: "text" as const, text: "Error: provide at least a title or an icon to update." }], isError: true };
        }
        const userId = await store.resolveUserId();
        const row = await store.findItem(notebook_id, JOP_TYPE_FOLDER, userId);
        if (!row) return { content: [{ type: "text" as const, text: `Notebook '${notebook_id}' not found.` }], isError: true };
        const parsed = parseJoplinContent(row.content);
        if (parsed.isDeleted)
          return { content: [{ type: "text" as const, text: `Notebook '${notebook_id}' is in the trash.` }], isError: true };
        // Preserve all existing fields; only change the title and/or the icon when provided
        await store.updateFolder(row, { title, icon: icon !== undefined ? buildIconString(icon) : undefined }, userId);
        const changes: string[] = [];
        if (title !== undefined) changes.push(`Title: ${parsed.title} → ${title}`);
        if (icon !== undefined) changes.push(`Icon: ${icon.emoji}`);
        return { content: [{ type: "text" as const, text: `Notebook updated:\n${changes.join("\n")}\nID: ${notebook_id}` }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  defineTool(
    server,
    "move_notebook",
    "Move a notebook under another notebook, or back to the root with an empty parent_id. Refuses to nest a notebook inside itself or one of its descendants.",
    MUTATING,
    {
      notebook_id: z.string().describe("The ID of the notebook to move"),
      parent_id: z.string().describe("Target notebook ID, or an empty string to move it to the root"),
    },
    async ({ notebook_id, parent_id }) => {
      try {
        const userId = await store.resolveUserId();
        const row = await store.findItem(notebook_id, JOP_TYPE_FOLDER, userId);
        if (!row) return { content: [{ type: "text" as const, text: `Notebook '${notebook_id}' not found.` }], isError: true };
        const parsed = parseJoplinContent(row.content);
        if (parsed.isDeleted)
          return { content: [{ type: "text" as const, text: `Notebook "${parsed.title}" is in the trash.` }], isError: true };
        const targetId = parent_id.trim();
        let targetJopId = "";
        let targetTitle = "";
        const alive = (await store.listFolders(userId))
          .map((f) => ({
            id: f.id,
            jopId: String(f.jop_id),
            parent: String(f.jop_parent_id || ""),
            title: parseJoplinContent(f.content).title,
            deleted: parseJoplinContent(f.content).isDeleted,
          }))
          .filter((f) => !f.deleted);
        if (targetId) {
          const target = alive.find((f) => f.id === targetId || f.jopId === targetId);
          if (!target) return { content: [{ type: "text" as const, text: `Target notebook '${targetId}' not found.` }], isError: true };
          if (target.jopId === row.jop_id)
            return { content: [{ type: "text" as const, text: "A notebook cannot be its own parent." }], isError: true };
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
            return {
              content: [{ type: "text" as const, text: `Cannot move: "${target.title}" is a sub-notebook of "${parsed.title}" (cycle).` }],
              isError: true,
            };
          }
          targetJopId = target.jopId;
          targetTitle = target.title;
        }
        await store.moveFolder(row, targetJopId, userId);
        return {
          content: [
            {
              type: "text" as const,
              text: `Notebook moved: **${parsed.title}**\nTo: ${targetTitle || "root"}\nID: ${row.id}`,
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
    "delete_notebook",
    "Delete a notebook (folder) from Joplin (soft delete - moves to trash). SAFETY: the notebook must be empty - if it still contains notes or sub-notebooks, move or delete them first. IMPORTANT: You MUST call this function to delete a notebook. NEVER tell the user a notebook has been deleted without actually calling this function and receiving a success response.",
    DESTRUCTIVE,
    { notebook_id: z.string().describe("The ID of the notebook to delete") },
    async ({ notebook_id }) => {
      try {
        const userId = await store.resolveUserId();
        const row = await store.findItem(notebook_id, JOP_TYPE_FOLDER, userId);
        if (!row) return { content: [{ type: "text" as const, text: `Notebook '${notebook_id}' not found.` }], isError: true };
        const parsed = parseJoplinContent(row.content);
        if (parsed.isDeleted)
          return { content: [{ type: "text" as const, text: `Notebook '${notebook_id}' is already in the trash.` }], isError: true };
        // Safety: refuse if the notebook is not empty (notes or sub-notebooks still inside)
        const alive = await store.countAliveChildren(row.jop_id, userId);
        if (alive > 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Notebook "${parsed.title}" is not empty (${alive} item(s)). Move or delete its notes and sub-notebooks first.`,
              },
            ],
            isError: true,
          };
        }
        // Soft delete: set deleted_time, preserving all other fields (incl. the 'icon' string)
        await store.softDeleteFolder(row, userId);
        return {
          content: [
            {
              type: "text" as const,
              text: `Notebook moved to the trash: **${parsed.title}**\nID: ${notebook_id}\nThe notebook sits in the Joplin trash.`,
            },
          ],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  );
}
