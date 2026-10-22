# KANBAN

Open work only. Finished items leave the board once merged and released — the released history
lives in [CHANGELOG.md](CHANGELOG.md) and `git log`.

## Backlog

### #3 [I18N] English agent-facing output

- [ ] translate the result strings of the 37 tools (roughly 150 strings); tool names, arguments and
      item shapes stay untouched
- [ ] replay the real-data round trips (notes, notebooks, todos, attachments, trash, tags, history)

### #4 [REFACTOR] Split the monolith

- [ ] `src/index.ts` is ~2 250 lines: extract the database layer, the HTTP layer and the tools by
      domain (`notes`, `notebooks`, `attachments`, `tags`, `trash`, `history`)
- [ ] keep the behaviour and every tool schema identical; `docs/sync-shapes.md` stays the reference

### #5 [TESTS] Unit and integration suite, CI

- [ ] vitest on the pure pieces: `recordChange`, `parseDueDate`, `resourceSummary`,
      `buildResourceContent`, `renderHistoryDiff`
- [ ] integration run against a throwaway Joplin Server + PostgreSQL compose (create, update, trash,
      restore, purge — the cycle applied by hand today)
- [ ] GitHub Actions: typecheck, tests, build, markdownlint on the docs
- [ ] add the CI badge to the README once the workflow exists

### #6 [DISTRIBUTION] Publish what is already built

- [ ] `ghcr.io` image on tag — `build.sh` already defaults to `ghcr.io/openhoat`
- [ ] npm package if the local/stdio story makes sense (the server needs a database, unlike the
      sibling MCP projects)
- [ ] documentation site, if the README starts to be too long for the detail it carries
