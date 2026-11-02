# KANBAN

Open work only. Finished items leave the board once merged and released — the released history
lives in [CHANGELOG.md](CHANGELOG.md) and `git log`.

## Backlog

### #8 [SECURITY] Read-only API key for server-side write protection

- [ ] second bearer (`MCP_API_KEY_RO`, empty = disabled, keeping the fail-closed posture): tools
      annotated `readOnlyHint: false` (20 of 37) and `POST /files` reject with a clear error
- [ ] derive the gate from the existing tool annotations instead of a hand-written list;
      `stack.e2e.test.ts` already pins the annotations
- [ ] document `MCP_API_KEY_RO` in the README (same env-var table as the other settings)
- [ ] known limit, to state in the docs: opencode cannot pick a key per agent, so plan mode keeps
      its client-side permissions; this key targets other clients and manual mistakes
- [ ] the gate lives server-side by design: the spec treats tool annotations as untrusted input
      (clients MUST consider them untrusted unless the server is trusted), so no client-side
      strategy can be relied upon

### #7 [TEST] Handler-level tests on a fake store

- [ ] the store seam exists (`src/store/index.ts`), so a tool module can now run against an in-memory
      store: cover the argument validation and the message formatting of a few handlers without Docker
- [ ] keep `src/test/e2e/` as the reference for the SQL itself

### #6 [DISTRIBUTION] Publish what is already built

- [ ] `ghcr.io` image on tag — `build.sh` already defaults to `ghcr.io/openhoat`
- [ ] npm package if the local/stdio story makes sense (the server needs a database, unlike the
      sibling MCP projects)
- [ ] documentation site, if the README starts to be too long for the detail it carries
