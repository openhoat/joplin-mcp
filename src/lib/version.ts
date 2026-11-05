/** Version advertised by the MCP server, taken from package.json. */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Read the package version instead of duplicating it in a constant.
 *
 * A hardcoded copy drifted: `src/index.ts` said 1.14.1 while package.json moved
 * to 1.16.0, and only the end-to-end suite, which compares the advertised
 * version with the package one, noticed after a deploy. Reading the file makes
 * the two impossible to disagree.
 *
 * The candidates cover the layouts the module is loaded from: `src/lib/` under
 * the test runner and `dist/lib/` in the image (package.json two levels up),
 * plus a flattened `dist/` build (one level up). A missing package.json is an
 * error rather than a fallback: a server that announces a wrong version is
 * worse than one that refuses to start.
 */
export function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of ["../package.json", "../../package.json", "../../../package.json"]) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(here, candidate), "utf-8"));
      if (typeof parsed === "object" && parsed !== null && "version" in parsed && typeof parsed.version === "string") {
        return parsed.version;
      }
    } catch {
      // Not this layout: try the next one.
    }
  }
  throw new Error("package.json not found: cannot advertise the server version");
}
