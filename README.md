# joplin-mcp

**An MCP server that gives AI agents full control over a self-hosted Joplin — by writing to the sync database the way a desktop client does.**

Notes, notebooks, todos, attachments, tags, trash, notebook hierarchy, conflict triage and note
history — 37 tools over the Model Context Protocol, one container, one database connection, and
**no Joplin credentials inside the MCP container**.

> **Unofficial.** This project is not affiliated with Joplin. It writes plaintext rows into the
> PostgreSQL schema of Joplin Server (tested against **3.7.2**) and will break if that schema
> changes. It bypasses the sync API and the encryption layer by design: **back up your database
> before pointing it at real notes.**

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/openhoat/joplin-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/openhoat/joplin-mcp/actions/workflows/ci.yml)
[![node: 20+](https://img.shields.io/badge/node-20%2B-green.svg)](Dockerfile)
[![MCP: streamable-http](https://img.shields.io/badge/MCP-streamable--http-8A2BE2.svg)](https://modelcontextprotocol.io)
[![M8ven Verified](https://m8ven.ai/badge/mcp/openhoat-joplin-mcp-1uoqwj?variant=verified)](https://m8ven.ai/mcp/openhoat-joplin-mcp-1uoqwj?s=readme)

## Why not the Joplin API?

- The **Web Clipper API** is served by the desktop app: unreachable from a server, and only a
  subset of what a client can do.
- The **sync API** transports E2EE-encrypted item blobs: you would need the master keys, and you
  would still be limited to item-level upserts.
- The server's **PostgreSQL database** holds exactly what clients sync. Writing an item body plus
  its `changes_2` event and `user_items` ownership — the three rows a desktop client writes — makes
  the change visible to every connected client, and unlocks what the APIs never expose: trash
  lifecycle, in-place attachment replacement, note history, notebook tree.

The price of that power is that **the writes must reproduce the client's shapes exactly**. They are
documented, with the evidence behind each one, in [docs/sync-shapes.md](docs/sync-shapes.md) — read it
before changing anything that touches the database.

## Architecture

```text
  AI agent (opencode, Claude Code, Cline...)
           |  MCP over HTTP (streamable-http) + Bearer key
           v
  +-----------------+        +------------------------------+
  |   joplin-mcp    |------->|   PostgreSQL (Joplin DB)     |
  |  Express + SDK  |  SQL   |  items, changes_2,           |
  |                 |        |  user_items, item_resources  |
  +--------+--------+        +------------^-----------------+
           | raw HTTP (256 MB)            |
           | /files/<id>                  | sync
           v                              |
    big attachments                       Joplin Server --> desktop / mobile clients
```

The MCP server never talks to Joplin Server: it writes where clients read from. A change becomes
visible on a desktop as soon as that desktop syncs — there is no push, exactly like another client
that has just uploaded.

## Quick start

### 1. Build the image

```bash
docker build -t joplin-mcp:latest .
```

### 2. Run it next to a Joplin Server

[compose.yml](compose.yml) describes the three services: PostgreSQL, Joplin Server and the MCP
server. It is the same file CI starts for the end-to-end suite (`compose.ci.yml` only publishes
PostgreSQL on loopback), so the documented stack and the tested stack cannot drift apart.

```bash
cp .env.example .env    # set POSTGRES_PASSWORD and MCP_API_KEY, then:
docker compose up -d --build
```

Generate the API key with `openssl rand -hex 32`: the server **refuses to start** without a real
key (an empty value or the `change-me` placeholder is rejected), because it writes to your notes
database.

Create the Joplin account at <http://localhost:22300> (the server seeds an admin account on first
start), and **point the MCP server at that user**:

```sql
-- one row per Joplin account; the id is what JOPLIN_USER_ID expects
SELECT id, email, created_time FROM users ORDER BY created_time;
```

Set `JOPLIN_USER_ID` to that id (when it is omitted, the server uses the oldest account — fine for a
single-user instance, ambiguous otherwise).

### 3. Connect an agent

opencode — `opencode.jsonc`, remote MCP with a header (V2 nests servers under `mcp.servers`):

```jsonc
{
  "mcp": {
    "joplin": {
      "type": "remote",
      "url": "http://localhost:8000/mcp",
      "headers": { "Authorization": "Bearer {env:JOPLIN_API_KEY}" },
    },
  },
}
```

Claude Code:

```bash
claude mcp add --transport http joplin http://localhost:8000/mcp \
  --header "Authorization: Bearer $JOPLIN_API_KEY"
```

Ask the agent to “summarize my open todos in Joplin”: it calls `list_todos`, then `get_note`.

## MCP tools (37)

Every tool validates its arguments against a **strict** schema: an unknown or misspelled field (for
example `content` instead of `body`) is rejected with an `InvalidParams` error instead of being
silently stripped, so a typo can never turn into a no-op that still answers success.

### Notes (8)

| Tool                     | Purpose                                                      |
| ------------------------ | ------------------------------------------------------------ |
| `search_notes`           | Search titles and bodies, returns ids and short previews     |
| `get_recent_notes`       | Most recently updated notes                                  |
| `get_note`               | Full content of one note                                     |
| `list_notes_in_notebook` | Notes of a notebook                                          |
| `create_note`            | Create a note (title, body, notebook, todo fields)           |
| `update_note`            | Update title and/or body, merge-preserving every other field |
| `move_note`              | Change the note's notebook                                   |
| `delete_note`            | Soft delete → trash                                          |

### Notebooks (7)

| Tool                | Purpose                                                    |
| ------------------- | ---------------------------------------------------------- |
| `list_notebooks`    | Flat list of notebooks                                     |
| `search_notebooks`  | Search notebooks by name                                   |
| `get_notebook_tree` | Resolved hierarchy as an indented tree, with note counts   |
| `create_notebook`   | Create a notebook (title, icon)                            |
| `update_notebook`   | Rename and/or set the icon                                 |
| `move_notebook`     | Move under another notebook or to the root, refuses cycles |
| `delete_notebook`   | Soft delete, refuses a non-empty notebook                  |

### Todos (1)

| Tool         | Purpose                                                      |
| ------------ | ------------------------------------------------------------ |
| `list_todos` | Open/completed todos, scoped by notebook, sorted by due date |

A Joplin reminder is a note with `is_todo`, `todo_due` (epoch ms) and `todo_completed`: `create_note`
and `update_note` expose those three fields, there is no separate alarm type in the database.

### Attachments (9)

| Tool                        | Purpose                                                                 |
| --------------------------- | ----------------------------------------------------------------------- |
| `list_note_attachments`     | Attachments of a note                                                   |
| `list_resources`            | Most recently updated attachments, across notes                         |
| `get_resource`              | Metadata: title, MIME, size, blob presence, referencing notes           |
| `download_resource`         | Bytes as base64 (10 MiB by default, 32 MiB maximum)                     |
| `add_resource`              | Create an attachment from inline base64 (32 MiB maximum)                |
| `update_resource`           | Replace the bytes in place — ids kept, so every `:/` link keeps working |
| `attach_resource_to_note`   | Append the markdown link to a note body                                 |
| `unlink_resource_from_note` | Remove the links from a note body, keep the attachment                  |
| `delete_resource`           | Soft delete → trash, refuses while a note still links it unless `force` |

### Trash (2)

| Tool           | Purpose                                                            |
| -------------- | ------------------------------------------------------------------ |
| `list_trash`   | Notes and attachments deleted but not purged                       |
| `restore_item` | Restore one item; ids are preserved, so every link keeps resolving |

### Tags (8)

| Tool                   | Purpose                                            |
| ---------------------- | -------------------------------------------------- |
| `list_tags`            | All tags with their note counts                    |
| `add_tag`              | Create a tag                                       |
| `list_note_tags`       | Tags of a note                                     |
| `attach_tag_to_note`   | Assign a tag                                       |
| `detach_tag_from_note` | Remove a tag from a note, keep the tag             |
| `list_notes_with_tag`  | Notes carrying a tag                               |
| `rename_tag`           | Rename, id kept so assignments survive             |
| `delete_tag`           | Trash the tag and its assignments, never the notes |

### Navigation and history (2)

| Tool                    | Purpose                                                                   |
| ----------------------- | ------------------------------------------------------------------------- |
| `list_conflicted_notes` | Notes flagged as sync conflicts (`is_conflict`)                           |
| `get_note_history`      | Server-side history entries: date, changed fields, `+`/`-` text fragments |

History is written by Joplin Server on client syncs. The MCP server writes rows directly, so a note
created through it has no history until a client saves it; restoring a version is left to
`update_note` on purpose.

## HTTP endpoints

| Endpoint                        | Method          | Purpose                                          |
| ------------------------------- | --------------- | ------------------------------------------------ |
| `/health`                       | GET             | Health check (the only route without the Bearer) |
| `/mcp`                          | POST/GET/DELETE | MCP streamable HTTP transport                    |
| `/sse`                          | GET             | Legacy SSE transport                             |
| `/files/<id>`                   | GET             | Download an attachment (raw bytes)               |
| `/files?filename=…&note_id=…`   | POST            | Create an attachment from a raw body             |
| `/files/<id>?filename=…&mime=…` | PUT             | Replace an attachment's bytes, ids preserved     |

The `/files` routes take the same `Authorization: Bearer` header as `/mcp`. They exist because
inline base64 is capped at 32 MiB while the raw routes accept 256 MB — the practical way to move
videos, slide decks and archives in and out.

## Limits

| Limit                               | Value                   | Why                                   |
| ----------------------------------- | ----------------------- | ------------------------------------- |
| Inline base64 (add/update resource) | 32 MiB                  | MCP JSON payload, memory per request  |
| `/mcp` request body                 | 48 MB                   | Headroom for a 32 MiB file in base64  |
| `/files` upload and download        | 256 MB                  | Binary payloads bypass the JSON layer |
| `download_resource` inline          | 10 MiB (32 MiB maximum) | Keeps agent context small             |
| PostgreSQL pool                     | 5 connections           | One MCP instance, one writer          |

## Configuration

| Variable             | Default                   | Description                                                                              |
| -------------------- | ------------------------- | ---------------------------------------------------------------------------------------- |
| `JOPLIN_DB_HOST`     | `pgsql`                   | PostgreSQL host                                                                          |
| `JOPLIN_DB_PORT`     | `5432`                    | PostgreSQL port                                                                          |
| `JOPLIN_DB_NAME`     | `joplin`                  | Database name                                                                            |
| `JOPLIN_DB_USER`     | `postgres`                | Database user — needs read/write on `items`, `changes_2`, `user_items`, `item_resources` |
| `JOPLIN_DB_PASSWORD` | `postgres`                | Database password                                                                        |
| `JOPLIN_USER_ID`     | first user                | Joplin account the server acts for (see the `users` query above)                         |
| `MCP_API_KEY`        | **required**              | Bearer key on every route except `/health` and `/`; the server will not start without it |
| `MCP_PORT`           | `8000`                    | HTTP listening port                                                                      |
| `MCP_PUBLIC_URL`     | `http://localhost:<port>` | Base URL advertised in tool output and download links — set it behind a proxy            |

> The server is **fail closed**: with no `MCP_API_KEY` it exits at startup. Tokens are compared
> through their SHA-256 digests with `crypto.timingSafeEqual`. `/health` and `/` stay public so a
> container healthcheck needs no secret.

## How writes work

Every mutation writes the item body, one `changes_2` event (`type` 1 create / 2 update / 3 delete,
`item_type` 2 on create and 1 on update) and, when creating, the `user_items` ownership row. Deletions
are soft (`deleted_time`), attachments keep their binary until a client purges the trash, and a
replacement rewrites the blob in place so that `:/` links in note bodies survive.

The exact shapes, the ones real clients write in Joplin 3.7.2, live in
[docs/sync-shapes.md](docs/sync-shapes.md).

A stored item whose body is not valid Joplin v3 JSON is read leniently (display paths show the raw
text) but never rewritten: every merge goes through a strict parser and fails with an explicit
error, so a corrupt row is fixed in a client instead of being silently overwritten with a
fabricated object.

## Development

```bash
npm ci
npm run build        # tsc → dist/ (tests excluded)
npm start            # node dist/index.js (reads the environment above)

npm run qa           # biome (lint + format), prettier and markdownlint
npm run typecheck    # tsc --noEmit, tests included
npm test             # vitest unit suite
npm run test:coverage
npm run validate     # qa + typecheck + coverage + build — the gate CI runs
```

The pure layer (`src/lib/`) is unit-tested: item content parsing and building, formatting, todo
dates, history diffs, ids and markdown links. That is where the Joplin shapes live, so it is where a
regression is cheapest to catch. Coverage thresholds apply to it and ratchet up as the handlers move
behind testable seams ([KANBAN.md](KANBAN.md)).

```text
src/
  index.ts        composition root: configuration, store, tool registration, HTTP surface
  config.ts       environment and size limits
  store/          the database seam: connection, core primitives, one module per aggregate
  tools/          the 37 MCP tools, one module per domain (notes, notebooks, attachments, ...)
  lib/            pure layer, no I/O: the Joplin shapes live here
```

No handler ever holds a `pg` pool: each tool module receives the `Store` interface
(`src/store/index.ts`), so a handler can be exercised with a fake store and no database. The SQL
itself is not mocked — a fake pool would only assert that the mock was called — `src/test/e2e/`
drives the real stack instead: the HTTP transport, the writes and the rows they must produce.

```bash
docker compose -f compose.yml -f compose.ci.yml up -d --build

E2E_API_KEY=<MCP_API_KEY> E2E_DB_PASSWORD=<POSTGRES_PASSWORD> npm run test:e2e

docker compose -f compose.yml -f compose.ci.yml down -v
```

The suite walks one lifecycle in order (notebook, note, todo, attachment, tag, trash, restore),
asserts the `items` and `changes_2` rows each call must write, then purges what it created and
refuses to pass while any row mentions its `e2e-…` prefix. It is skipped — not failed — when
`E2E_API_KEY` and `E2E_DB_PASSWORD` are absent, so a plain checkout stays green without Docker.

CI runs the same gate on every push and pull request, plus a Docker build of the image and that
end-to-end run against the compose stack.

## Out of scope

Assumed and documented, not accidental: E2EE and master keys, shares and collaboration, ENEX import,
settings, manual ordering (`order`), pinning, server-side trash purge (clients own it), and automatic
restore of a history version.

## Roadmap

Open work only, in [KANBAN.md](KANBAN.md); released history in [CHANGELOG.md](CHANGELOG.md).

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). For anything that
touches the database, `docs/sync-shapes.md` is the contract: verify a shape against a real client
before implementing it.

## Security

Report a vulnerability privately rather than in a public issue — see [SECURITY.md](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE).
