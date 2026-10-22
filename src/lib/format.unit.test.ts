import { describe, expect, it } from "vitest";
import { fileExtensionFromName, formatBytes, formatTimestamp, guessMime } from "./format.js";

describe("formatTimestamp", () => {
  it("returns N/A for empty, zero, negative and unparsable values", () => {
    expect(formatTimestamp(0)).toBe("N/A");
    expect(formatTimestamp("")).toBe("N/A");
    expect(formatTimestamp(-1)).toBe("N/A");
    expect(formatTimestamp("abc")).toBe("N/A");
  });

  it("renders UTC ISO without milliseconds, for numbers and bigint-strings alike", () => {
    expect(formatTimestamp(1700000000000)).toBe("2023-11-14 22:13:20");
    expect(formatTimestamp("1700000000000")).toBe("2023-11-14 22:13:20");
  });
});

describe("formatBytes", () => {
  it("keeps bytes plain and switches to KB/MB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(5 * 1024 * 1024 + 512 * 1024)).toBe("5.5 MB");
  });
});

describe("fileExtensionFromName", () => {
  it("lowercases the suffix and rejects missing or oversized ones", () => {
    expect(fileExtensionFromName("report.PDF")).toBe("pdf");
    expect(fileExtensionFromName("archive.tar.gz")).toBe("gz");
    expect(fileExtensionFromName("noext")).toBe("");
    expect(fileExtensionFromName("toolong.abcdefghijklm")).toBe("");
    expect(fileExtensionFromName("  spaced.TXT  ")).toBe("txt");
  });
});

describe("guessMime", () => {
  it("maps known extensions and falls back to octet-stream", () => {
    expect(guessMime("photo.JPEG")).toBe("image/jpeg");
    expect(guessMime("notes.md")).toBe("text/markdown");
    expect(guessMime("sheet.unknown")).toBe("application/octet-stream");
    expect(guessMime("no-extension")).toBe("application/octet-stream");
  });
});
