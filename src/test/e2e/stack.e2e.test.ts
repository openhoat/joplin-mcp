/**
 * End-to-end run against the stack from `deploy/compose.yml`: the real HTTP
 * transport, the real PostgreSQL writes, the real tool handlers.
 *
 * The cases are ordered on purpose — one run drives the whole lifecycle
 * (notebook → note → todo → attachment → tag → trash → purge) and later cases
 * reuse the ids created by earlier ones. Unit tests never depend on order; this
 * suite is a scripted transaction, so it does.
 *
 * Skipped when `E2E_API_KEY` or `E2E_DB_PASSWORD` is absent, which keeps a
 * plain checkout and `npm test` independent from Docker.
 */

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connectDatabase,
  countResidue,
  type E2eConfig,
  itemId,
  jopId,
  McpClient,
  type PurgeTargets,
  packageVersion,
  purgeTargets,
  readConfig,
  resolveTargets,
  type ToolCall,
} from "./harness.js";

const config = readConfig();
const prefix = `e2e-${Date.now().toString(36)}`;

describe.skipIf(!config)("joplin-mcp against a real stack", () => {
  const cfg = config as E2eConfig;
  const mcp = new McpClient(cfg);
  const created: string[] = [];
  const state = { notebook: "", subNotebook: "", note: "", todo: "", resource: "", resourceJopId: "", tag: "" };
  let db: Client;
  let targets: PurgeTargets = { ids: [], jopIds: [] };

  const expectText = (result: ToolCall, needle: string): void => {
    expect(result.isError, result.text).toBe(false);
    expect(result.text).toContain(needle);
  };
  const expectRefusal = (result: ToolCall, needle: string): void => {
    expect(result.isError, result.text).toBe(true);
    expect(result.text).toContain(needle);
  };

  /** Item row as stored: type plus the parsed JSON body. */
  const itemRow = async (id: string): Promise<{ jop_type: number; body: Record<string, unknown> }> => {
    const result = await db.query("SELECT jop_type, content FROM items WHERE id = $1", [id]);
    expect(result.rowCount, `items row for ${id}`).toBe(1);
    return { jop_type: result.rows[0].jop_type, body: JSON.parse(result.rows[0].content.toString()) };
  };

  /** Sync events written for one item. `changes_2.id` is random, so rows are never asserted in order. */
  const changes = async (id: string): Promise<Array<{ type: number; item_type: number }>> => {
    const result = await db.query("SELECT type, item_type FROM changes_2 WHERE item_id = $1", [id]);
    return result.rows.map((row) => ({ type: row.type, item_type: row.item_type }));
  };

  const count = async (sql: string, params: unknown[]): Promise<number> => Number((await db.query(sql, params)).rows[0].count);

  beforeAll(async () => {
    db = await connectDatabase(cfg);
  });

  afterAll(async () => {
    if (!db) {
      return;
    }
    // Belt and braces: a failed case above must not leave rows behind.
    await purgeTargets(db, await resolveTargets(db, created));
    await db.end();
  });

  it("serves the public probes and refuses unauthenticated calls", async () => {
    const health = await fetch(`${cfg.mcpUrl}/health`);
    expect(health.status).toBe(200);
    expect(((await health.json()) as { status: string }).status).toBe("ok");

    const root = await fetch(`${cfg.mcpUrl}/`);
    expect(root.status).toBe(200);
    expect(((await root.json()) as { service: string }).service).toBe("joplin-mcp");

    const anonymous = await mcp.request({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { "Content-Type": "application/json" });
    expect(anonymous.status).toBe(401);

    const wrongKey = await mcp.request(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { "Content-Type": "application/json", Authorization: "Bearer not-the-key" },
    );
    expect(wrongKey.status).toBe(401);

    const anonymousDownload = await fetch(`${cfg.mcpUrl}/files/anything`);
    expect(anonymousDownload.status).toBe(401);
  });

  it("advertises the package version and the full tool list", async () => {
    const response = await mcp.request({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1.0.0" } },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { serverInfo: { name: string; version: string }; protocolVersion: string } };
    expect(body.result.serverInfo.name).toBe("joplin");
    expect(body.result.serverInfo.version).toBe(packageVersion());
    expect(body.result.protocolVersion).toBeTruthy();

    const listed = await mcp.request({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = (await listed.json()) as { result: { tools: Array<{ name: string }> } };
    expect(tools.result.tools.length).toBe(37);
  });

  it("creates nested notebooks and returns them as a tree", async () => {
    const notebook = await mcp.call("create_notebook", { title: `${prefix}-nb` });
    expectText(notebook, `Notebook created: **${prefix}-nb**`);
    state.notebook = itemId(notebook.text);
    created.push(state.notebook);

    const sub = await mcp.call("create_notebook", { title: `${prefix}-sub`, parent_notebook_id: state.notebook });
    expectText(sub, "Sub-notebook of:");
    state.subNotebook = itemId(sub.text);
    created.push(state.subNotebook);

    const tree = await mcp.call("get_notebook_tree");
    expectText(tree, `${prefix}-nb`);
    expectText(tree, `${prefix}-sub`);

    const row = await itemRow(state.notebook);
    expect(row.jop_type).toBe(2);
    expect(row.body.title).toBe(`${prefix}-nb`);
    // The hierarchy lives in the `jop_parent_id` column, not in the item body:
    // checked on a production database, 59 folders written by desktop clients,
    // none of them with a `parent_id` key in the JSON.
    expect(row.body.parent_id).toBeUndefined();
    const hierarchy = await db.query("SELECT id, jop_id, jop_parent_id FROM items WHERE id = ANY($1::text[])", [
      [state.notebook, state.subNotebook],
    ]);
    const byId = new Map(hierarchy.rows.map((candidate) => [candidate.id as string, candidate]));
    expect(byId.get(state.notebook)?.jop_parent_id).toBe("");
    expect(byId.get(state.subNotebook)?.jop_parent_id).toBe(byId.get(state.notebook)?.jop_id);
    expect(await count("SELECT count(*)::int AS count FROM user_items WHERE item_id = $1", [state.notebook])).toBe(1);
    expect(await changes(state.notebook)).toEqual([{ type: 1, item_type: 1 }]);
  });

  it("creates, reads and updates a note", async () => {
    const note = await mcp.call("create_note", { title: `${prefix}-note`, body: "first body", notebook_id: state.notebook });
    expectText(note, `Note created: **${prefix}-note**`);
    state.note = itemId(note.text);
    created.push(state.note);

    expectText(await mcp.call("get_note", { note_id: state.note }), `Notebook: ${prefix}-nb`);

    const afterCreate = await itemRow(state.note);
    expect(afterCreate.jop_type).toBe(1);
    expect(afterCreate.body.body).toBe("first body");
    expect(await changes(state.note)).toEqual([{ type: 1, item_type: 2 }]);

    expectText(
      await mcp.call("update_note", { note_id: state.note, title: `${prefix}-note-2`, body: "second body" }),
      `Note updated: **${prefix}-note-2**`,
    );

    const afterUpdate = await itemRow(state.note);
    expect(afterUpdate.body.title).toBe(`${prefix}-note-2`);
    expect(afterUpdate.body.body).toBe("second body");
    const noteChanges = await changes(state.note);
    expect(noteChanges).toHaveLength(2);
    expect(noteChanges).toContainEqual({ type: 1, item_type: 2 });
    expect(noteChanges).toContainEqual({ type: 2, item_type: 1 });
  });

  it("drives a todo from open to done", async () => {
    const todo = await mcp.call("create_note", {
      title: `${prefix}-todo`,
      body: "todo body",
      notebook_id: state.notebook,
      is_todo: true,
      todo_due: "2026-11-03T09:00",
    });
    expectText(todo, `Note created: **${prefix}-todo**`);
    state.todo = itemId(todo.text);
    created.push(state.todo);

    const open = await itemRow(state.todo);
    expect(open.body.is_todo).toBe(1);
    expect(Number(open.body.todo_due)).toBeGreaterThan(0);
    // Joplin omits the keys that are zero.
    expect(Number(open.body.todo_completed ?? 0)).toBe(0);

    expectText(await mcp.call("list_todos", { status: "open", notebook_id: state.notebook }), `[ ] **${prefix}-todo**`);
    expectText(await mcp.call("update_note", { note_id: state.todo, todo_completed: true }), "completed ");
    expectText(await mcp.call("list_todos", { status: "done", notebook_id: state.notebook }), `[x] **${prefix}-todo**`);
    expect(Number((await itemRow(state.todo)).body.todo_completed)).toBeGreaterThan(0);
  });

  it("carries an attachment through create, download, replace, unlink and relink", async () => {
    const resource = await mcp.call("add_resource", {
      filename: `${prefix}.txt`,
      data_base64: Buffer.from("hello").toString("base64"),
      note_id: state.note,
    });
    expectText(resource, `Attachment created: **${prefix}.txt**`);
    state.resource = itemId(resource.text);
    state.resourceJopId = jopId(resource.text);
    created.push(state.resource);

    expectText(await mcp.call("list_note_attachments", { note_id: state.note }), "Attachments (1):");
    expectText(await mcp.call("get_resource", { resource_id: state.resource }), "Size: 5 B");
    expectText(await mcp.call("download_resource", { resource_id: state.resource }), Buffer.from("hello").toString("base64"));

    // The HTTP surface serves the same bytes, with the same Bearer key.
    const downloaded = await fetch(`${cfg.mcpUrl}/files/${state.resource}`, { headers: { Authorization: `Bearer ${cfg.apiKey}` } });
    expect(downloaded.status).toBe(200);
    expect(await downloaded.text()).toBe("hello");

    const metadata = await itemRow(state.resource);
    expect(metadata.jop_type).toBe(4);
    expect(metadata.body.title).toBe(`${prefix}.txt`);
    const blob = await db.query("SELECT content FROM items WHERE name = $1", [`.resource/${state.resourceJopId}`]);
    expect(blob.rowCount).toBe(1);
    expect(blob.rows[0].content.toString()).toBe("hello");
    expect(await count("SELECT count(*)::int AS count FROM item_resources WHERE item_id = $1", [state.note])).toBe(1);

    expectText(
      await mcp.call("update_resource", { resource_id: state.resource, data_base64: Buffer.from("hello v2").toString("base64") }),
      `Content replaced: **${prefix}.txt**`,
    );
    expectText(await mcp.call("get_resource", { resource_id: state.resource }), "Size: 8 B");
    // Ids survive the replacement, so `/files` and `:/` links keep resolving.
    const replaced = await db.query("SELECT content FROM items WHERE name = $1", [`.resource/${state.resourceJopId}`]);
    expect(replaced.rows[0].content.toString()).toBe("hello v2");

    expectText(
      await mcp.call("unlink_resource_from_note", { note_id: state.note, resource_id: state.resource }),
      "Link removed (1 occurrence(s))",
    );
    expect(await count("SELECT count(*)::int AS count FROM item_resources WHERE item_id = $1", [state.note])).toBe(0);

    expectText(
      await mcp.call("attach_resource_to_note", { note_id: state.note, resource_id: state.resource }),
      `Attachment linked: **${prefix}.txt**`,
    );
    expect(await count("SELECT count(*)::int AS count FROM item_resources WHERE item_id = $1", [state.note])).toBe(1);
  });

  it("tags a note, lists it by tag, renames the tag and detaches it", async () => {
    const tag = await mcp.call("add_tag", { title: `${prefix}-tag` });
    expectText(tag, `Tag created: **${prefix}-tag**`);
    state.tag = itemId(tag.text);
    created.push(state.tag);

    const noteJopId = String((await db.query("SELECT jop_id FROM items WHERE id = $1", [state.note])).rows[0].jop_id);
    const relations = async (): Promise<Array<Record<string, unknown>>> => {
      const result = await db.query("SELECT content FROM items WHERE jop_type = 6 AND encode(content, 'escape') LIKE $1", [
        `%${noteJopId}%`,
      ]);
      return result.rows.map((row) => JSON.parse(row.content.toString()));
    };
    const activeRelations = async (): Promise<number> => (await relations()).filter((rel) => Number(rel.deleted_time || 0) === 0).length;

    expectText(await mcp.call("attach_tag_to_note", { note_id: state.note, tag_id: state.tag }), `Tag assigned: **${prefix}-tag**`);
    expect(await activeRelations()).toBe(1);
    expectText(await mcp.call("list_note_tags", { note_id: state.note }), "Tags on the note (1):");
    expectText(await mcp.call("list_notes_with_tag", { tag_id: state.tag }), `Notes with tag "${prefix}-tag"`);

    expectText(
      await mcp.call("rename_tag", { tag_id: state.tag, title: `${prefix}-tag-2` }),
      `Tag renamed: **${prefix}-tag → ${prefix}-tag-2**`,
    );
    expect((await itemRow(state.tag)).body.title).toBe(`${prefix}-tag-2`);

    expectText(await mcp.call("detach_tag_from_note", { note_id: state.note, tag_id: state.tag }), `Tag removed: **${prefix}-tag-2**`);
    // Detaching is a soft delete of the relation, like a desktop client does.
    expect(await activeRelations()).toBe(0);
    expect((await relations()).length).toBeGreaterThan(0);
    expectText(await mcp.call("get_note_history", { note_id: state.note }), "No server history for");
  });

  it("refuses the calls that would lose data", async () => {
    expectRefusal(await mcp.call("delete_notebook", { notebook_id: state.notebook }), "is not empty");
    expectRefusal(await mcp.call("delete_resource", { resource_id: state.resource }), "is still referenced");
    expectRefusal(await mcp.call("get_note", { note_id: "doesnotexist" }), "not found");
    expectRefusal(await mcp.call("update_note", { note_id: state.note }), "provide at least");
    // A misspelled field is a protocol error, never a silent no-op: a stray
    // `content` used to be stripped by the SDK, answering "updated" with nothing written.
    await expect(mcp.call("update_note", { note_id: state.note, content: "typo" })).rejects.toThrow(/Unrecognized key/);
    expectText(await mcp.call("search_notes", { query: "zzzz-introuvable-zzzz" }), "No note found");
  });

  it("trashes items softly and restores them", async () => {
    expectText(await mcp.call("delete_note", { note_id: state.note }), `Note moved to the trash: **${prefix}-note-2**`);
    expect(Number((await itemRow(state.note)).body.deleted_time)).toBeGreaterThan(0);
    // The type-3 event is the documented contract; `item_type` on a delete is not
    // part of it, so it is not pinned here.
    expect((await changes(state.note)).map((change) => change.type)).toContain(3);

    expectText(await mcp.call("list_trash", {}), "Trash (");
    expectText(await mcp.call("restore_item", { item_id: state.note }), `Note restored: **${prefix}-note-2**`);
    expect((await itemRow(state.note)).body.deleted_time).toBe(0);

    expectText(
      await mcp.call("delete_resource", { resource_id: state.resource, force: true }),
      `Attachment moved to the trash: **${prefix}.txt**`,
    );
    expectText(await mcp.call("delete_tag", { tag_id: state.tag }), `Tag moved to the trash: **${prefix}-tag-2**`);
  });

  it("leaves zero residue once the run is purged", async () => {
    targets = await resolveTargets(db, created);
    await purgeTargets(db, targets);

    const residue = await countResidue(db, targets, prefix);
    expect(residue).toEqual({ items: 0, changes: 0, ownership: 0, links: 0, content: 0 });
  });
});
