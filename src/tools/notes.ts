import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildNoteContent, parseJoplinContent, parseRawJson } from "../lib/content.js";
import { formatTimestamp } from "../lib/format.js";
import { CHANGE_DELETED, CHANGE_UPDATED, JOP_TYPE_FOLDER, JOP_TYPE_NOTE, type JoplinItemRow } from "../lib/joplin-types.js";
import { parseDueDate } from "../lib/todo.js";
import type { ToolDeps } from "./deps.js";
import { defineTool } from "./tool.js";

export function registerNoteTools(server: McpServer, deps: ToolDeps): void {
  const { store } = deps;

  defineTool(
    server,
    "search_notes",
    "Search notes by title or body content. Returns note IDs with SHORT PREVIEWS only. WORKFLOW: 1) Call this to find notes. 2) Then call `get_note` with the note_id to read the FULL content. NEVER answer questions about note content based only on the preview - always call `get_note` first.",
    {
      query: z.string().describe("The search text"),
      notebook_id: z.string().optional().describe("Optional notebook ID to filter search within"),
      limit: z.number().default(10).describe("Max results"),
    },
    async ({ query, notebook_id, limit }) => {
      try {
        const userId = await store.resolveUserId();
        let parentJopId: string | undefined;
        if (notebook_id) {
          // notebook_id is the base62 'id'; the parent column holds the jop_id (UUID hex)
          const folder = await store.findItem(notebook_id, JOP_TYPE_FOLDER, userId);
          parentJopId = folder ? folder.jop_id : notebook_id;
        }
        const rows = await store.search(userId, { query, parentJopId, limit });
        if (rows.length === 0) return { content: [{ type: "text" as const, text: `No note found for '${query}'.` }] };
        const notes = rows
          .map((row: any) => {
            const parsed = parseJoplinContent(row.content);
            const isTruncated = parsed.body.length > 200;
            return {
              id: row.id,
              title: parsed.title,
              preview: isTruncated ? parsed.body.substring(0, 200) : parsed.body,
              isTruncated,
              isDeleted: parsed.isDeleted,
              updated: formatTimestamp(row.updated_time),
            };
          })
          .filter((n: any) => !n.isDeleted);
        if (notes.length === 0) return { content: [{ type: "text" as const, text: `No note found for '${query}'.` }] };
        const lines = notes.map(
          (n: any) =>
            `**${n.title}** (ID: ${n.id})\n   Updated: ${n.updated}\n   Preview: ${n.preview}${n.isTruncated ? "\n   Preview truncated: call get_note with this ID to read the whole note" : ""}`,
        );
        return { content: [{ type: "text" as const, text: `Found ${notes.length} note(s) for '${query}':\n\n${lines.join("\n\n")}` }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  defineTool(
    server,
    "get_note",
    "Read the FULL content of a specific Joplin note. ALWAYS call this before answering questions about a note's content. Use after `search_notes` or `get_recent_notes` to get the complete text from a note_id. This returns the entire note body without truncation.",
    { note_id: z.string().describe("The ID of the note") },
    async ({ note_id }) => {
      try {
        const userId = await store.resolveUserId();
        const row = await store.findItem(note_id, JOP_TYPE_NOTE, userId);
        if (!row) return { content: [{ type: "text" as const, text: `Note '${note_id}' not found.` }], isError: true };
        const parsed = parseJoplinContent(row.content);
        if (parsed.isDeleted) return { content: [{ type: "text" as const, text: `Note '${note_id}' is in the trash.` }], isError: true };
        const notebookName = row.jop_parent_id ? (await store.findFolderTitle(userId, String(row.jop_parent_id))) || "" : "";
        let text = `**${parsed.title}**\n`;
        if (notebookName) text += `Notebook: ${notebookName}\n`;
        text += `Updated: ${formatTimestamp(row.updated_time)}\nID: ${row.id}\n\n--- Content ---\n\n${parsed.body}`;
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  defineTool(
    server,
    "get_recent_notes",
    "Get the most recently updated notes. Returns note IDs with SHORT PREVIEWS only. WORKFLOW: 1) Call this to find recent notes. 2) Then call `get_note` with the note_id to read the FULL content. NEVER answer questions about note content based only on the preview.",
    {
      limit: z.number().default(10).describe("Max notes"),
      notebook_id: z.string().optional().describe("Optional notebook ID to filter"),
    },
    async ({ limit, notebook_id }) => {
      try {
        const userId = await store.resolveUserId();
        let parentJopId: string | undefined;
        if (notebook_id) {
          // notebook_id is the base62 'id'; the parent column holds the jop_id (UUID hex)
          const folder = await store.findItem(notebook_id, JOP_TYPE_FOLDER, userId);
          parentJopId = folder ? folder.jop_id : notebook_id;
        }
        const rows = await store.listRecent(userId, { parentJopId, limit });
        if (rows.length === 0) return { content: [{ type: "text" as const, text: "No notes found." }] };
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
        if (notes.length === 0) return { content: [{ type: "text" as const, text: "No notes found." }] };
        const lines = notes.map(
          (n: any) =>
            `**${n.title}** (ID: ${n.id})\n   ${n.updated} - ${n.preview}${n.isTruncated ? "\n   Preview truncated: call get_note with this ID to read the whole note" : ""}`,
        );
        return { content: [{ type: "text" as const, text: `Recent notes (${notes.length}):\n\n${lines.join("\n\n")}` }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  defineTool(
    server,
    "list_todos",
    "List the todos (notes carrying a checkbox): open ones, completed ones or both, optionally scoped to a notebook, sorted by due date. In Joplin a reminder is a todo with a `todo_due` date — there is no separate alarm item.",
    {
      status: z.enum(["open", "done", "all"]).default("open").describe("Which todos to list: not completed, completed, or both"),
      notebook_id: z.string().optional().describe("Restrict the listing to one notebook"),
      limit: z.number().default(50).describe("Max todos to return"),
    },
    async ({ status, notebook_id, limit }) => {
      try {
        const userId = await store.resolveUserId();
        let parentJopId: string | undefined;
        if (notebook_id) {
          const nb = await store.findItem(notebook_id, JOP_TYPE_FOLDER, userId);
          if (!nb) return { content: [{ type: "text" as const, text: `Notebook '${notebook_id}' not found.` }], isError: true };
          parentJopId = nb.jop_id;
        }
        const notes = await store.listNotes(userId);
        const folderTitles = await store.listFolderTitles(userId);
        const todos = (notes as JoplinItemRow[])
          .map((row) => {
            const json = parseRawJson(row.content);
            return {
              id: row.id,
              title: String(json.title || "(untitled)"),
              isTodo: Number(json.is_todo || 0) === 1,
              deleted: Number(json.deleted_time || 0) > 0,
              due: Number(json.todo_due || 0),
              completed: Number(json.todo_completed || 0),
              parent: String(row.jop_parent_id),
              notebook: folderTitles.get(String(row.jop_parent_id)) || "",
              updated: Number(row.updated_time),
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
          const empty = status === "open" ? "No open todo." : status === "done" ? "No completed todo." : "No todo found.";
          return { content: [{ type: "text" as const, text: empty }] };
        }
        const lines = shown.map((t) => {
          const parts = [
            t.due > 0 ? `due ${formatTimestamp(t.due)}` : "",
            t.completed > 0 ? `completed ${formatTimestamp(t.completed)}` : "",
          ].filter(Boolean);
          return `${t.completed > 0 ? "[x]" : "[ ]"} **${t.title}**${parts.length ? ` · ${parts.join(" · ")}` : ""}\n   ID: ${t.id}${t.notebook ? ` · notebook: ${t.notebook}` : ""}`;
        });
        const header = status === "done" ? "completed" : status === "open" ? "open" : "all";
        return {
          content: [{ type: "text" as const, text: `Todos (${todos.length} ${header}, ${shown.length} shown):\n\n${lines.join("\n")}` }],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  defineTool(
    server,
    "create_note",
    "Create a new note in Joplin. IMPORTANT: You MUST call this function to create a note. NEVER tell the user a note has been created without actually calling this function and receiving a success response. The note text goes in `body` (Markdown); unknown fields are rejected. Use `search_notebooks` or `list_notebooks` first to find the notebook_id if the user specifies a notebook.",
    {
      title: z.string().describe("Note title"),
      body: z.string().describe("Note body in Markdown"),
      notebook_id: z.string().optional().describe("Optional notebook ID to place the note in"),
      is_todo: z.boolean().optional().describe("Create a todo (checklist) instead of a plain note"),
      todo_due: z
        .union([z.string(), z.number(), z.null()])
        .optional()
        .describe("Due date for a todo: ISO 8601 string (`2026-11-03`, `2026-11-03T09:00`) or epoch milliseconds. null clears it"),
      todo_completed: z.boolean().optional().describe("Mark the todo as completed right away (uses the current time)"),
    },
    async ({ title, body, notebook_id, is_todo, todo_due, todo_completed }) => {
      try {
        const userId = await store.resolveUserId();
        const now = Date.now();
        const todoExtra: Record<string, any> = {};
        if (is_todo !== undefined) todoExtra.is_todo = is_todo ? 1 : 0;
        if (todo_due !== undefined) {
          const due = parseDueDate(todo_due);
          if (due === null || Number.isNaN(due))
            return {
              content: [{ type: "text" as const, text: `Error: due date '${todo_due}' cannot be parsed (ISO 8601 or epoch ms expected).` }],
              isError: true,
            };
          todoExtra.todo_due = due;
          if (due > 0 && todoExtra.is_todo === undefined) todoExtra.is_todo = 1;
        }
        if (todo_completed) {
          todoExtra.todo_completed = now;
          todoExtra.is_todo = 1;
        }
        let parentJopId = "";
        if (notebook_id) {
          // notebook_id is the base62 'id' - look up the corresponding 'jop_id' (UUID hex)
          const folder = await store.findItem(notebook_id, JOP_TYPE_FOLDER, userId);
          if (folder) parentJopId = folder.jop_id;
        }
        if (!parentJopId) {
          // Fallback: use the first available notebook
          parentJopId = (await store.firstFolderJopId(userId)) || "";
        }
        const note = await store.createNote({ title, body, parentJopId, extra: todoExtra, userId });
        // Resolve the notebook title: a raw jop_id tells the caller nothing
        let notebookLabel = "default";
        if (parentJopId) {
          notebookLabel = (await store.findFolderTitle(userId, parentJopId)) || parentJopId;
        }
        return { content: [{ type: "text" as const, text: `Note created: **${title}**\nID: ${note.id}\nNotebook: ${notebookLabel}` }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  defineTool(
    server,
    "update_note",
    "Update an existing note's title and/or body. IMPORTANT: You MUST call this function to update a note. NEVER tell the user a note has been updated without actually calling this function and receiving a success response. WORKFLOW: 1) Use `search_notes` or `get_note` to find the note_id. 2) Call `update_note` with that note_id and the fields to change: `body` for the Markdown body, `title` for the title. Unknown fields are rejected. The note_id is REQUIRED and must come from a previous search.",
    {
      note_id: z.string().describe("REQUIRED: The ID of the note to update (from search_notes or get_note)"),
      title: z.string().optional().describe("New title (optional, keeps existing if not provided)"),
      body: z.string().optional().describe("New body content in Markdown (optional, keeps existing if not provided)"),
      is_todo: z.boolean().optional().describe("Turn the note into a todo (true) or back into a plain note (false)"),
      todo_due: z
        .union([z.string(), z.number(), z.null()])
        .optional()
        .describe("Due date: ISO 8601 string or epoch milliseconds; null clears it"),
      todo_completed: z.boolean().optional().describe("true marks the todo done now, false reopens it"),
    },
    async ({ note_id, title, body, is_todo, todo_due, todo_completed }) => {
      try {
        const hasTodoChange = is_todo !== undefined || todo_due !== undefined || todo_completed !== undefined;
        if (!title && !body && !hasTodoChange)
          return {
            content: [{ type: "text" as const, text: "Error: provide at least a title, a body or a todo field to update." }],
            isError: true,
          };
        const userId = await store.resolveUserId();
        const row = await store.findItem(note_id, JOP_TYPE_NOTE, userId);
        if (!row) return { content: [{ type: "text" as const, text: `Note '${note_id}' not found.` }], isError: true };
        const stored = parseRawJson(row.content);
        const newTitle = title || stored.title || "(untitled)";
        const newBody = body !== undefined ? body : (stored.body ?? stored.markdown ?? "");
        const now = Date.now();
        // Preserve every field the tool does not manage. parseRawJson is strict:
        // a document we could not read fails here instead of being rebuilt from scratch.
        const extra: Record<string, any> = {};
        for (const [k, v] of Object.entries(stored)) {
          if (!["title", "body", "source", "source_url"].includes(k)) extra[k] = v;
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
          if (due === undefined || Number.isNaN(due))
            return {
              content: [{ type: "text" as const, text: `Error: due date '${todo_due}' cannot be parsed (ISO 8601 or epoch ms expected).` }],
              isError: true,
            };
          extra.todo_due = due;
          if (due > 0 && extra.is_todo === undefined) extra.is_todo = 1;
        }
        if (todo_completed !== undefined) {
          extra.todo_completed = todo_completed ? now : 0;
          if (todo_completed) extra.is_todo = 1;
          else if (extra.is_todo === undefined) extra.is_todo = 1;
        }
        const contentBytes = buildNoteContent(newTitle, newBody, { ...extra, user_updated_time: now });
        await store.writeNoteContent(row, contentBytes, userId, CHANGE_UPDATED, 1);
        const todoLine = (() => {
          if (!hasTodoChange) return "";
          if (Number(extra.is_todo) !== 1) return "\nTodo disabled (plain note)";
          const due = Number(extra.todo_due || 0);
          const done = Number(extra.todo_completed || 0);
          return `\nTodo · due: ${due > 0 ? formatTimestamp(due) : "none"} · ${done > 0 ? `completed ${formatTimestamp(done)}` : "open"}`;
        })();
        return { content: [{ type: "text" as const, text: `Note updated: **${newTitle}**\nID: ${note_id}${todoLine}` }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  defineTool(
    server,
    "delete_note",
    "Delete a note from Joplin (soft delete - moves to trash). IMPORTANT: You MUST call this function to delete a note. NEVER tell the user a note has been deleted without actually calling this function and receiving a success response. Deleted notes are filtered from search results automatically.",
    { note_id: z.string().describe("The ID of the note to delete") },
    async ({ note_id }) => {
      try {
        const userId = await store.resolveUserId();
        const row = await store.findItem(note_id, JOP_TYPE_NOTE, userId);
        if (!row) return { content: [{ type: "text" as const, text: `Note '${note_id}' not found.` }], isError: true };
        const stored = parseRawJson(row.content);
        const now = Date.now();
        // Soft delete: set deleted_time in JSON content, keeping every other field.
        // parseRawJson is strict, so a document we could not read fails here.
        const extra: Record<string, any> = {};
        for (const [k, v] of Object.entries(stored)) {
          if (!["title", "body", "source", "source_url"].includes(k)) extra[k] = v;
        }
        const contentBytes = buildNoteContent(stored.title || "(untitled)", stored.body ?? stored.markdown ?? "", {
          ...extra,
          deleted_time: now,
          user_updated_time: now,
        });
        await store.writeNoteContent(row, contentBytes, userId, CHANGE_DELETED);
        return {
          content: [
            {
              type: "text" as const,
              text: `Note moved to the trash: **${stored.title || "(untitled)"}**\nID: ${note_id}\nThe note sits in the Joplin trash.`,
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
    "move_note",
    "Move a note to a different notebook. IMPORTANT: You MUST call this function to move a note. NEVER tell the user a note has been moved without actually calling this function. Use `search_notes` to find the note_id and `search_notebooks` to find the target_notebook_id.",
    {
      note_id: z.string().describe("The ID of the note to move"),
      target_notebook_id: z.string().describe("The ID of the destination notebook/folder"),
    },
    async ({ note_id, target_notebook_id }) => {
      try {
        const userId = await store.resolveUserId();
        const note = await store.findItem(note_id, JOP_TYPE_NOTE, userId);
        if (!note) return { content: [{ type: "text" as const, text: `Note '${note_id}' not found.` }], isError: true };
        // target_notebook_id is base62 'id' - the parent column needs the jop_id (UUID hex)
        const folder = await store.findItem(target_notebook_id, JOP_TYPE_FOLDER, userId);
        if (!folder)
          return {
            content: [
              { type: "text" as const, text: `Notebook '${target_notebook_id}' not found. Use list_notebooks to see the notebooks.` },
            ],
            isError: true,
          };
        const noteParsed = parseJoplinContent(note.content);
        const folderParsed = parseJoplinContent(folder.content);
        await store.moveNote(note, folder.jop_id, userId);
        return { content: [{ type: "text" as const, text: `Note moved: **${noteParsed.title}**\nTo notebook: ${folderParsed.title}` }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  );
}
