# Contributing

Thanks for looking at `joplin-mcp`. A few rules keep the server honest with real Joplin clients.

## Before you write code

**Read [docs/sync-shapes.md](docs/sync-shapes.md).** Every write here replicates what a desktop
client produces, verified on a real database. Do not change a shape from memory or from the Joplin
source alone: inspect the rows a client writes, then implement.

## Ground rules

- **No private infrastructure in the tree**: no personal host name, registry, user id or key — the
  defaults must work for someone running the compose example.
- **No new dependency** unless it removes more complexity than it adds; the runtime is Express, the
  MCP SDK, `pg` and `zod`.
- **Agent-facing output stays in English**, tool names and argument shapes stay stable (agents cache
  them).
- **Deletions go to the trash**; nothing the server does may purge a blob or break a `:/` link that a
  note body relies on.
- **Test on a disposable notebook, note and attachment**, then purge the rows so that no residue is
  left in the database. This is how every feature here was validated.

## Sending a change

1. Open an issue for anything larger than a fix, so the shape and the scope can be discussed first.
2. One topic per commit, conventional-commit message (`feat:`, `fix:`, `docs:`, `chore:`).
3. Bump the version in `package.json` and `src/index.ts`, and add a [CHANGELOG.md](CHANGELOG.md) entry
   in the same commit as the release.
4. Describe in the PR what you verified against a real database — not just “tests pass”.

## Security

Never report a vulnerability in a public issue: see [SECURITY.md](SECURITY.md).
