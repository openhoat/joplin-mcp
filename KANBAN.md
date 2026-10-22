# KANBAN

Open work only. Finished items leave the board once merged and released — the released history
lives in [CHANGELOG.md](CHANGELOG.md) and `git log`.

## Backlog

### #7 [TEST] Handler-level tests on a fake store

- [ ] the store seam exists (`src/store/index.ts`), so a tool module can now run against an in-memory
      store: cover the argument validation and the message formatting of a few handlers without Docker
- [ ] keep `src/test/e2e/` as the reference for the SQL itself

### #6 [DISTRIBUTION] Publish what is already built

- [ ] `ghcr.io` image on tag — `build.sh` already defaults to `ghcr.io/openhoat`
- [ ] npm package if the local/stdio story makes sense (the server needs a database, unlike the
      sibling MCP projects)
- [ ] documentation site, if the README starts to be too long for the detail it carries
