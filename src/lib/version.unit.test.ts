import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readPackageVersion } from "./version.js";

describe("readPackageVersion", () => {
  it("returns the version of the package.json that ships with the server", () => {
    const raw = readFileSync(new URL("../../package.json", import.meta.url), "utf-8");
    const { version } = JSON.parse(raw) as { version: string };
    expect(readPackageVersion()).toBe(version);
  });

  it("returns a semver, so a malformed package.json cannot pass silently", () => {
    expect(readPackageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
