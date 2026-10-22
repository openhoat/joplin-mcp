import { defineConfig } from "vitest/config";

/**
 * End-to-end suite: the real HTTP transport and a real PostgreSQL, started by
 * `compose.yml` + `compose.ci.yml`. It is a separate project on purpose — the
 * unit run (`npm test`) must stay green without Docker, and coverage thresholds
 * apply to the pure layer only.
 *
 *   docker compose -f compose.yml -f compose.ci.yml up -d --build
 *   E2E_API_KEY=... E2E_DB_PASSWORD=... npm run test:e2e
 *   docker compose -f compose.yml -f compose.ci.yml down -v
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/test/e2e/**/*.e2e.test.ts"],
    // The cases share one stack and create state in order; a single file, one worker.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
