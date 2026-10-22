import { describe, expect, it } from "vitest";
import { generateId, generateJopId, jopTypeToChangeItemType } from "./ids.js";

describe("generateId", () => {
  it("produces 22-character base62 identifiers, unique across calls", () => {
    const ids = new Set(Array.from({ length: 500 }, () => generateId()));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(id).toMatch(/^[0-9a-zA-Z]{22}$/);
  });
});

describe("generateJopId", () => {
  it("produces the 32-hex form used by Joplin Server", () => {
    expect(generateJopId()).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("jopTypeToChangeItemType", () => {
  it("swaps notes to 2 and every other type to 1, as the desktop client does", () => {
    expect(jopTypeToChangeItemType(1)).toBe(2);
    expect(jopTypeToChangeItemType(2)).toBe(1);
    expect(jopTypeToChangeItemType(4)).toBe(1);
    expect(jopTypeToChangeItemType(5)).toBe(1);
    expect(jopTypeToChangeItemType(6)).toBe(1);
  });
});
