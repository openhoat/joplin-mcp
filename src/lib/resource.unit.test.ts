import { describe, expect, it } from "vitest";
import type { JoplinItemRow } from "./joplin-types.js";
import { resourceSummary } from "./resource.js";

function row(overrides: Partial<JoplinItemRow> = {}): JoplinItemRow {
  return {
    id: "id22chars0000000000000",
    name: "abc.md",
    content: Buffer.from("{}"),
    jop_id: "0123456789abcdef0123456789abcdef",
    jop_parent_id: "",
    jop_type: 4,
    content_size: 0,
    updated_time: 1700000000000,
    ...overrides,
  };
}

describe("resourceSummary", () => {
  it("reads the resource metadata as stored by the desktop client", () => {
    const content = Buffer.from(
      JSON.stringify({ title: "report.pdf", mime: "application/pdf", size: 2048, file_extension: "pdf", deleted_time: 0 }),
    );
    expect(resourceSummary(row({ content }))).toEqual({
      id: "id22chars0000000000000",
      jopId: "0123456789abcdef0123456789abcdef",
      title: "report.pdf",
      mime: "application/pdf",
      size: 2048,
      updated: "2023-11-14 22:13:20",
      fileExtension: "pdf",
      isDeleted: false,
    });
  });

  it("derives the mime type and extension when the metadata omits them", () => {
    const content = Buffer.from(JSON.stringify({ title: "photo.JPG" }));
    const summary = resourceSummary(row({ content }));
    expect(summary.mime).toBe("image/jpeg");
    expect(summary.fileExtension).toBe("jpg");
    expect(summary.size).toBe(0);
  });

  it("flags a resource sitting in the trash", () => {
    const content = Buffer.from(JSON.stringify({ title: "gone.txt", deleted_time: 1700000000000 }));
    expect(resourceSummary(row({ content })).isDeleted).toBe(true);
  });
});
