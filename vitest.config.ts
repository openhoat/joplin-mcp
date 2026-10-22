import { defineConfig } from "vitest/config";

/**
 * Unit tests cover the pure layer (`src/lib/**`): content parsing and building,
 * formatting, todo dates, history diffs, ids and markdown links. The tool handlers
 * in `src/index.ts` are wired to PostgreSQL: they are exercised end to end against
 * a real stack (see CONTRIBUTING.md), not mocked here — a fake pool would only
 * assert that the mock was called.
 *
 * Coverage thresholds therefore apply to `src/lib/**` only. They ratchet up with
 * the refactor tracked as KANBAN #4, when the handlers move behind testable seams.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.unit.test.ts"],
    coverage: {
      provider: "v8",
      reportsDirectory: "dist/coverage",
      include: ["src/lib/**/*.ts"],
      exclude: ["src/lib/**/*.unit.test.ts"],
      reporter: ["text", "lcov"],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
});
