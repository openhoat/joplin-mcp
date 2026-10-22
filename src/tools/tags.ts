import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseJoplinContent, parseRawJson } from "../lib/content.js";
import { formatTimestamp } from "../lib/format.js";
import { JOP_TYPE_NOTE, JOP_TYPE_TAG, type JoplinItemRow } from "../lib/joplin-types.js";
import type { ToolDeps } from "./deps.js";

export function registerTagTools(server: McpServer, deps: ToolDeps): void {
  const { store } = deps;

  server.tool(
    "list_tags",
    "List all Joplin tags with their note counts. Use the returned tag ID with `attach_tag_to_note` / `detach_tag_from_note`.",
    {},
    async () => {
      try {
        const userId = await store.resolveUserId();
        const tags = await store.listTags(userId);
        const relations = await store.listRelations(userId);
        const counts = new Map<string, number>();
        for (const row of relations) {
          const json = parseRawJson(row.content);
          if (Number(json.deleted_time || 0) > 0) continue;
          const tagId = String(json.tag_id || "");
          counts.set(tagId, (counts.get(tagId) || 0) + 1);
        }
        const alive = (tags as JoplinItemRow[])
          .filter((row) => !parseJoplinContent(row.content).isDeleted)
          .map((row) => ({
            id: row.id,
            jopId: row.jop_id,
            title: parseJoplinContent(row.content).title,
            count: counts.get(row.jop_id) || 0,
          }))
          .sort((a, b) => a.title.localeCompare(b.title));
        if (alive.length === 0) return { content: [{ type: "text" as const, text: "No tags found." }] };
        const lines = alive.map((t) => `**${t.title}** (ID: ${t.id}) - ${t.count} note(s)`);
        return { content: [{ type: "text" as const, text: `Tags (${alive.length}):\n\n${lines.join("\n")}` }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  server.tool(
    "add_tag",
    "Create a new Joplin tag. Returns the tag ID for `attach_tag_to_note`.",
    { title: z.string().describe("Tag title") },
    async ({ title }) => {
      try {
        const userId = await store.resolveUserId();
        const trimmed = title.trim();
        if (!trimmed) return { content: [{ type: "text" as const, text: "Error: the tag title is empty." }] };
        const duplicate = await store.findTagByTitle(userId, trimmed);
        if (duplicate)
          return { content: [{ type: "text" as const, text: `Tag "${trimmed}" already exists (ID: ${duplicate.id}).` }], isError: true };
        const tag = await store.createTag({ title: trimmed, userId });
        return { content: [{ type: "text" as const, text: `Tag created: **${trimmed}**\nID: ${tag.id}\njop_id: ${tag.jopId}` }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  server.tool(
    "list_note_tags",
    "List the tags assigned to a note.",
    { note_id: z.string().describe("The ID of the note") },
    async ({ note_id }) => {
      try {
        const userId = await store.resolveUserId();
        const note = await store.findItem(note_id, JOP_TYPE_NOTE, userId);
        if (!note) return { content: [{ type: "text" as const, text: `Note '${note_id}' not found.` }], isError: true };
        const relations = await store.listRelations(userId);
        const tagJopIds = relations
          .map((row) => ({ json: parseRawJson(row.content) }))
          .filter(({ json }: any) => json.note_id === note.jop_id && Number(json.deleted_time || 0) === 0)
          .map(({ json }: any) => String(json.tag_id));
        if (tagJopIds.length === 0) return { content: [{ type: "text" as const, text: `Note '${note_id}' has no tag.` }] };
        const tags = (await store.listTags(userId)).filter((row) => tagJopIds.includes(String(row.jop_id)));
        const tagsList = tags
          .map((row) => ({ id: row.id, title: parseJoplinContent(row.content).title }))
          .filter((t) => t.title)
          .sort((a, b) => a.title.localeCompare(b.title));
        const lines = tagsList.map((t) => `**${t.title}** (ID: ${t.id})`);
        return { content: [{ type: "text" as const, text: `Tags on the note (${tagsList.length}):\n\n${lines.join("\n")}` }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  server.tool(
    "attach_tag_to_note",
    "Assign a tag to a note. Creates the note<->tag relation item used by Joplin sync; no-op if the tag is already assigned.",
    {
      note_id: z.string().describe("The ID of the note"),
      tag_id: z.string().describe("The tag ID (MCP id or Joplin 32-hex id)"),
    },
    async ({ note_id, tag_id }) => {
      try {
        const userId = await store.resolveUserId();
        const note = await store.findItem(note_id, JOP_TYPE_NOTE, userId);
        if (!note) return { content: [{ type: "text" as const, text: `Note '${note_id}' not found.` }], isError: true };
        const tag = await store.findItem(tag_id, JOP_TYPE_TAG, userId);
        if (!tag) return { content: [{ type: "text" as const, text: `Tag '${tag_id}' not found.` }], isError: true };
        const relations = await store.listRelations(userId);
        const already = relations.some((row) => {
          const json = parseRawJson(row.content);
          return (
            String(json.tag_id || "") === tag.jop_id && String(json.note_id || "") === note.jop_id && Number(json.deleted_time || 0) === 0
          );
        });
        if (already) {
          return {
            content: [
              { type: "text" as const, text: `Tag "${parseJoplinContent(tag.content).title}" is already assigned to note ${note.id}.` },
            ],
          };
        }
        await store.createAssignment({ tagJopId: tag.jop_id, noteJopId: note.jop_id, userId });
        return {
          content: [{ type: "text" as const, text: `Tag assigned: **${parseJoplinContent(tag.content).title}**\nNote: ${note.id}` }],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  server.tool(
    "detach_tag_from_note",
    "Remove a tag from a note (soft-deletes the note<->tag relation item). The tag itself is kept.",
    {
      note_id: z.string().describe("The ID of the note"),
      tag_id: z.string().describe("The tag ID (MCP id or Joplin 32-hex id)"),
    },
    async ({ note_id, tag_id }) => {
      try {
        const userId = await store.resolveUserId();
        const note = await store.findItem(note_id, JOP_TYPE_NOTE, userId);
        if (!note) return { content: [{ type: "text" as const, text: `Note '${note_id}' not found.` }], isError: true };
        const tag = await store.findItem(tag_id, JOP_TYPE_TAG, userId);
        if (!tag) return { content: [{ type: "text" as const, text: `Tag '${tag_id}' not found.` }], isError: true };
        const relations = await store.listRelations(userId);
        const matches = relations.filter((row) => {
          const json = parseRawJson(row.content);
          return (
            String(json.tag_id || "") === tag.jop_id && String(json.note_id || "") === note.jop_id && Number(json.deleted_time || 0) === 0
          );
        });
        if (matches.length === 0) {
          return {
            content: [
              { type: "text" as const, text: `Tag "${parseJoplinContent(tag.content).title}" is not assigned to note ${note.id}.` },
            ],
          };
        }
        await store.softDeleteAssignments(matches, userId);
        return {
          content: [{ type: "text" as const, text: `Tag removed: **${parseJoplinContent(tag.content).title}**\nNote: ${note.id}` }],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  server.tool(
    "list_notes_with_tag",
    "List the notes carrying a tag, most recently updated first (resolves the note<->tag relations used by Joplin sync).",
    {
      tag_id: z.string().describe("The tag ID (MCP id or Joplin 32-hex id)"),
      limit: z.number().default(50).describe("Max notes to return"),
    },
    async ({ tag_id, limit }) => {
      try {
        const userId = await store.resolveUserId();
        const tag = await store.findItem(tag_id, JOP_TYPE_TAG, userId);
        if (!tag) return { content: [{ type: "text" as const, text: `Tag '${tag_id}' not found.` }], isError: true };
        const tagTitle = parseJoplinContent(tag.content).title;
        if (parseJoplinContent(tag.content).isDeleted)
          return { content: [{ type: "text" as const, text: `Tag "${tagTitle}" is in the trash.` }], isError: true };
        const relations = await store.listRelations(userId);
        const noteJopIds = relations
          .map((row) => parseRawJson(row.content))
          .filter((json: any) => String(json.tag_id || "") === tag.jop_id && Number(json.deleted_time || 0) === 0)
          .map((json: any) => String(json.note_id || ""));
        if (noteJopIds.length === 0) return { content: [{ type: "text" as const, text: `Tag "${tagTitle}" is assigned to no note.` }] };
        const notes = await store.listNotesByJopIds(userId, noteJopIds);
        const folderTitles = await store.listFolderTitles(userId);
        const alive = (notes as JoplinItemRow[])
          .map((row) => ({
            id: row.id,
            title: parseJoplinContent(row.content).title,
            deleted: parseJoplinContent(row.content).isDeleted,
            notebook: folderTitles.get(String(row.jop_parent_id)) || "",
            updated: Number(row.updated_time),
          }))
          .filter((n) => !n.deleted)
          .sort((a, b) => b.updated - a.updated);
        if (alive.length === 0) return { content: [{ type: "text" as const, text: `Tag "${tagTitle}" is assigned to no live note.` }] };
        const shown = alive.slice(0, Math.min(limit, 200));
        const lines = shown.map(
          (n) => `**${n.title}**\n   ID: ${n.id}${n.notebook ? ` · notebook: ${n.notebook}` : ""} · updated ${formatTimestamp(n.updated)}`,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `Notes with tag "${tagTitle}" (${alive.length}, ${shown.length} shown):\n\n${lines.join("\n\n")}`,
            },
          ],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  server.tool(
    "rename_tag",
    "Rename a tag. The tag id is kept, so every note assignment survives.",
    {
      tag_id: z.string().describe("The tag ID (MCP id or Joplin 32-hex id)"),
      title: z.string().describe("New tag title"),
    },
    async ({ tag_id, title }) => {
      try {
        const userId = await store.resolveUserId();
        const tag = await store.findItem(tag_id, JOP_TYPE_TAG, userId);
        if (!tag) return { content: [{ type: "text" as const, text: `Tag '${tag_id}' not found.` }], isError: true };
        const current = parseJoplinContent(tag.content);
        if (current.isDeleted)
          return { content: [{ type: "text" as const, text: `Tag "${current.title}" is in the trash.` }], isError: true };
        const trimmed = title.trim();
        if (!trimmed) return { content: [{ type: "text" as const, text: "Error: the new title is empty." }] };
        if (trimmed === current.title)
          return { content: [{ type: "text" as const, text: `The tag is already called "${trimmed}" (ID: ${tag.id}).` }] };
        const clash = await store.findTagByTitle(userId, trimmed);
        if (clash && clash.id !== tag.id) {
          return {
            content: [
              {
                type: "text" as const,
                text: `A tag "${trimmed}" already exists (ID: ${clash.id}) - renaming would create a duplicate. Use attach_tag_to_note then detach_tag_from_note to merge by hand.`,
              },
            ],
            isError: true,
          };
        }
        await store.renameTag(tag, trimmed, userId);
        return { content: [{ type: "text" as const, text: `Tag renamed: **${current.title} → ${trimmed}**\nID: ${tag.id}` }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  server.tool(
    "delete_tag",
    "Delete a tag: trashes the tag and all its note assignments (soft delete, same as the desktop). The notes themselves are never touched.",
    { tag_id: z.string().describe("The tag ID (MCP id or Joplin 32-hex id)") },
    async ({ tag_id }) => {
      try {
        const userId = await store.resolveUserId();
        const tag = await store.findItem(tag_id, JOP_TYPE_TAG, userId);
        if (!tag) return { content: [{ type: "text" as const, text: `Tag '${tag_id}' not found.` }], isError: true };
        const parsedTag = parseJoplinContent(tag.content);
        if (parsedTag.isDeleted)
          return { content: [{ type: "text" as const, text: `Tag "${parsedTag.title}" is already in the trash.` }], isError: true };
        const relations = await store.listRelations(userId);
        const alive = relations.filter((row) => {
          const json = parseRawJson(row.content);
          return String(json.tag_id || "") === tag.jop_id && Number(json.deleted_time || 0) === 0;
        });
        await store.softDeleteAssignments(alive, userId);
        await store.softDeleteTag(tag, userId);
        return {
          content: [
            {
              type: "text" as const,
              text: `Tag moved to the trash: **${parsedTag.title}**\nID: ${tag.id}\n${alive.length} assignment(s) removed; the notes are untouched.`,
            },
          ],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  );
}
