import { describe, expect, it } from "vitest";
import {
  buildIconString,
  buildNoteContent,
  buildNoteTagContent,
  buildResourceContent,
  buildTagContent,
  MalformedItemContentError,
  parseJoplinContent,
  parseRawJson,
} from "./content.js";

describe("parseJoplinContent", () => {
  it("returns an untitled empty note for null content", () => {
    expect(parseJoplinContent(null)).toEqual({ title: "(untitled)", body: "", isDeleted: false, json: null });
  });

  it("reads title, body and metadata from the v3 JSON format", () => {
    const note = parseJoplinContent(Buffer.from(JSON.stringify({ title: "Hello", body: "World", user_data: "x" })));
    expect(note.title).toBe("Hello");
    expect(note.body).toBe("World");
    expect(note.isDeleted).toBe(false);
    expect(note.json).toMatchObject({ user_data: "x" });
  });

  it("falls back to the markdown field when body is absent", () => {
    expect(parseJoplinContent('{"title":"N","markdown":"# md"}').body).toBe("# md");
  });

  it("flags trashed notes and the is_todo=2 trash marker", () => {
    expect(parseJoplinContent('{"title":"t","deleted_time":1700000000000}').isDeleted).toBe(true);
    expect(parseJoplinContent('{"title":"t","is_todo":2}').isDeleted).toBe(true);
  });

  it("survives a nested JSON string in the icon field", () => {
    const raw = JSON.stringify({ title: "Icon note", body: "b", icon: JSON.stringify({ emoji: "🏦", name: "bank", type: 1 }) });
    const note = parseJoplinContent(raw);
    expect(note.title).toBe("Icon note");
    expect(note.body).toBe("b");
  });

  it("falls back to the legacy title/body text layout", () => {
    const note = parseJoplinContent("Title\n\nBody\nmore");
    expect(note.title).toBe("Title");
    expect(note.body).toBe("Body\nmore");
    expect(note.json).toBeNull();
  });

  it("keeps a single-line non-JSON content as both title and body", () => {
    const note = parseJoplinContent("plain text");
    expect(note.title).toBe("plain text");
    expect(note.body).toBe("plain text");
  });
});

describe("parseRawJson", () => {
  it("preserves every field, including the icon string", () => {
    const icon = JSON.stringify({ emoji: "🏦", name: "bank", type: 1 });
    const json = parseRawJson(JSON.stringify({ title: "t", icon }));
    expect(json.icon).toBe(icon);
  });

  it("returns an empty object for empty content", () => {
    expect(parseRawJson(null)).toEqual({});
  });

  it("rejects content that is not a JSON object instead of fabricating one", () => {
    expect(() => parseRawJson("Title\n\nBody")).toThrow(MalformedItemContentError);
    expect(() => parseRawJson('"a string"')).toThrow(MalformedItemContentError);
    expect(() => parseRawJson("[]")).toThrow(MalformedItemContentError);
    expect(() => parseRawJson("null")).toThrow(MalformedItemContentError);
  });
});

describe("buildNoteContent", () => {
  it("writes the desktop field set and applies extra fields last", () => {
    const data = JSON.parse(buildNoteContent("Title", "Body").toString("utf-8"));
    expect(data).toMatchObject({
      title: "Title",
      body: "Body",
      source: "joplin-mcp",
      markup_language: 1,
      is_todo: 0,
      deleted_time: 0,
    });
    expect(typeof data.user_updated_time).toBe("number");

    const todo = JSON.parse(buildNoteContent("Todo", "", { is_todo: 1, todo_due: 1700000000000 }).toString("utf-8"));
    expect(todo.is_todo).toBe(1);
    expect(todo.todo_due).toBe(1700000000000);
  });
});

describe("buildIconString", () => {
  it("always emits emoji, name and type as a compact JSON string", () => {
    expect(buildIconString({ emoji: "🏦" })).toBe('{"emoji":"🏦","name":"","type":1}');
    expect(buildIconString({ name: "bank", type: 2 })).toBe('{"emoji":"","name":"bank","type":2}');
  });
});

describe("buildResourceContent", () => {
  it("derives the extension and keeps the sync timestamps", () => {
    const data = JSON.parse(buildResourceContent({ title: "Report.PDF", mime: "application/pdf", size: 1234, now: 42 }).toString("utf-8"));
    expect(data).toMatchObject({
      title: "Report.PDF",
      mime: "application/pdf",
      size: 1234,
      file_extension: "pdf",
      filename: "",
      blob_updated_time: 42,
      user_updated_time: 42,
      created_time: 42,
    });
  });
});

describe("buildTagContent and buildNoteTagContent", () => {
  it("write the tag title and the note<->tag relation", () => {
    expect(JSON.parse(buildTagContent("urgent", 7).toString("utf-8"))).toMatchObject({ title: "urgent", created_time: 7 });
    expect(JSON.parse(buildNoteTagContent("tagjop", "notejop", 9).toString("utf-8"))).toMatchObject({
      tag_id: "tagjop",
      note_id: "notejop",
      user_updated_time: 9,
    });
  });
});
