import { describe, expect, it } from "vitest";
import { renderHistoryDiff } from "./history.js";

describe("renderHistoryDiff", () => {
  it("returns nothing for absent or shapeless input", () => {
    expect(renderHistoryDiff(null)).toEqual([]);
    expect(renderHistoryDiff({})).toEqual([]);
    expect(renderHistoryDiff([{ start1: 0, length1: 1 }])).toEqual([]);
  });

  it("keeps inserted and deleted fragments only, as +/- lines", () => {
    const hunks = [
      {
        diffs: [
          [0, "unchanged "],
          [1, "added"],
          [-1, "removed"],
        ],
      },
    ];
    expect(renderHistoryDiff(hunks)).toEqual(["+ added", "- removed"]);
  });

  it("accepts the JSON string form stored in metadata_diff", () => {
    const hunks = JSON.stringify([{ diffs: [[1, "title v2"]] }]);
    expect(renderHistoryDiff(hunks)).toEqual(["+ title v2"]);
  });

  it("normalises whitespace and drops fragments that are only spaces", () => {
    expect(renderHistoryDiff([{ diffs: [[1, "a\n   b"]] }])).toEqual(["+ a b"]);
    expect(renderHistoryDiff([{ diffs: [[1, "   "]] }])).toEqual([]);
  });

  it("truncates a long fragment with an ellipsis", () => {
    expect(renderHistoryDiff([{ diffs: [[1, "abcdefghij"]] }], 5)).toEqual(["+ abcde…"]);
  });

  it("falls back to the raw text when the string is not JSON", () => {
    expect(renderHistoryDiff("not json at all")).toEqual(["not json at all"]);
  });
});
