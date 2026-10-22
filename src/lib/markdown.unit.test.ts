import { describe, expect, it } from "vitest";
import { buildResourceLink, escapeMarkdownLabel } from "./markdown.js";

describe("escapeMarkdownLabel", () => {
  it("escapes brackets and backslashes only", () => {
    expect(escapeMarkdownLabel("plain")).toBe("plain");
    expect(escapeMarkdownLabel("[a](b) \\ c")).toBe("\\[a\\](b) \\\\ c");
  });
});

describe("buildResourceLink", () => {
  it("builds a Joplin resource link, as a file or as an image", () => {
    expect(buildResourceLink("report.pdf", "0123456789abcdef0123456789abcdef", false)).toBe(
      "[report.pdf](:/0123456789abcdef0123456789abcdef)",
    );
    expect(buildResourceLink("photo.png", "0123456789abcdef0123456789abcdef", true)).toBe(
      "![photo.png](:/0123456789abcdef0123456789abcdef)",
    );
  });

  it("escapes the label so a bracket in a filename cannot break the link", () => {
    expect(buildResourceLink("a[b].txt", "abc", false)).toBe("[a\\[b\\].txt](:/abc)");
  });
});
