import { describe, expect, it } from "vitest";
import { parseDueDate } from "./todo.js";

describe("parseDueDate", () => {
  it("keeps undefined as 'not provided'", () => {
    expect(parseDueDate(undefined)).toBeUndefined();
  });

  it("maps null and empty input to the 'clear' sentinel", () => {
    expect(parseDueDate(null)).toBe(0);
    expect(parseDueDate("")).toBe(0);
    expect(parseDueDate("   ")).toBe(0);
  });

  it("accepts epoch ms as number, flooring fractions and zeroing unusable numbers", () => {
    expect(parseDueDate(1700000000000)).toBe(1700000000000);
    expect(parseDueDate(1700000000000.9)).toBe(1700000000000);
    expect(parseDueDate(0)).toBe(0);
    expect(parseDueDate(-3)).toBe(0);
    expect(parseDueDate(Number.NaN)).toBe(0);
    expect(parseDueDate(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("accepts epoch ms as a numeric string", () => {
    expect(parseDueDate("1700000000000")).toBe(1700000000000);
  });

  it("accepts ISO 8601 strings", () => {
    expect(parseDueDate("2026-11-03T09:00:00Z")).toBe(Date.parse("2026-11-03T09:00:00Z"));
    expect(parseDueDate("2026-11-03")).toBe(Date.parse("2026-11-03"));
  });

  it("returns NaN when the string cannot be parsed, so the caller can refuse it", () => {
    expect(parseDueDate("next tuesday")).toBeNaN();
  });
});
