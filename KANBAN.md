# KANBAN

Open work only. Finished items leave the board once merged and released — the released history
lives in [CHANGELOG.md](CHANGELOG.md) and `git log`.

## Backlog

### #4 [REFACTOR] Split the monolith

- [x] move the pure layer to `src/lib/`: content, format, todo, history, ids, markdown, resource,
      types (`src/index.ts` is down to ~1 970 lines)
- [ ] extract the PostgreSQL layer (`pool`, `recordChange`, `findItem`, resource read/write) behind a
      seam so the handlers become testable without a database
- [ ] split the tools by domain (`notes`, `notebooks`, `attachments`, `tags`, `trash`, `history`)
- [ ] keep the behaviour and every tool schema identical; `docs/sync-shapes.md` stays the reference

### #5 [TESTS] Integration suite

- [x] vitest on the pure layer (39 tests, 98 % of statements) and `create_note` no longer prints a raw
      `jop_id`
- [x] coverage gate: 90 % of lines, statements and functions, 85 % of branches on `src/lib/**`
- [x] GitHub Actions: lint, prettier, markdownlint, typecheck, tests with coverage, build, Docker build
- [x] CI badge in the README
- [ ] integration run against a throwaway Joplin Server + PostgreSQL compose (create, update, trash,
      restore, purge — the cycle applied by hand today), wired into CI
- [ ] run the README quick-start compose end to end: it doubles as the integration stack, and it has
      never been executed as written

### #6 [DISTRIBUTION] Publish what is already built

- [ ] `ghcr.io` image on tag — `build.sh` already defaults to `ghcr.io/openhoat`
- [ ] npm package if the local/stdio story makes sense (the server needs a database, unlike the
      sibling MCP projects)
- [ ] documentation site, if the README starts to be too long for the detail it carries
