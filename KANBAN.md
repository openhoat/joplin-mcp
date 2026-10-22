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

### #6 [DISTRIBUTION] Publish what is already built

- [ ] `ghcr.io` image on tag — `build.sh` already defaults to `ghcr.io/openhoat`
- [ ] npm package if the local/stdio story makes sense (the server needs a database, unlike the
      sibling MCP projects)
- [ ] documentation site, if the README starts to be too long for the detail it carries
