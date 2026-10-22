# KANBAN

Open work only. Finished items leave the board once merged and released — the released history
lives in [CHANGELOG.md](CHANGELOG.md) and `git log`.

## Backlog

### #1 [INFRA] Push the repository to a remote (private first)

- [ ] decide the target (GitHub, private; `docker-stacks` stays on its own GitLab remote)
- [ ] push the history and verify that a fresh clone builds (`docker build -t joplin-mcp .`)
- [ ] keep private infrastructure out of the tree: `ghcr.io/openhoat` in `build.sh`,
      `MCP_PUBLIC_URL` default, deployment host names

### #2 [SECURITY] Fail closed, neutral defaults

- [ ] refuse to start without `MCP_API_KEY` (today an empty key means an unauthenticated server)
- [ ] compare the bearer token with `crypto.timingSafeEqual` instead of `!==`
- [ ] default `MCP_PUBLIC_URL` to `http://localhost:8000` and stop advertising the private deployment
- [ ] add `SECURITY.md` with the disclosure process before publication

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
- [ ] GitHub Actions: typecheck, tests, build, and markdownlint on the docs

### #6 [PUBLISH] Flip public

- [ ] leak gate: grep the whole tree for `private-infra`, registry hosts, user ids, keys, private paths
- [ ] badges (CI, license, node), `CONTRIBUTING.md`, compare links back in the CHANGELOG
- [ ] release the publication version (minor bump if the security work lands as a breaking change)
- [ ] stretch, not promised: `ghcr.io` image, npm package, documentation site
