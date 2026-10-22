# joplin-mcp

**An MCP server that gives AI agents full control over a self-hosted Joplin — by writing to the sync database the way a desktop client does.**

Notes, notebooks, todos, attachments, tags, trash, notebook hierarchy, conflict triage and note
history — 37 tools over the Model Context Protocol, one container, one database connection, and
**no Joplin credentials inside the MCP container**.

> **Unofficial.** This project is not affiliated with Joplin. It writes plaintext rows into the
> PostgreSQL schema of Joplin Server (tested against **3.7.2**) and will break if that schema
> changes. It bypasses the sync API and the encryption layer by design: **back up your database
> before pointing it at real notes.**

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
  AI agent (opencode, Claude Code, Cline…)
        │  MCP over HTTP (streamable-http) + Bearer key
        ▼
  ┌─────────────────┐        ┌──────────────────────────┐
  │   joplin-mcp    │───────▶│  PostgreSQL (Joplin DB)  │
  │  Express + SDK  │  SQL   │  items, changes_2,       │
  │                 │        │  user_items, item_resources
  └────────┬────────┘        └────────────▲─────────────┘
           │ raw HTTP (256 MB)            │
           │ /files/<id>                  │ sync
           ▼                              │
     big attachments              Joplin Server ──▶ desktop / mobile clients
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

```yaml
# compose.yml — Joplin Server + PostgreSQL + the MCP server
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: joplin
      POSTGRES_USER: joplin
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U joplin -d joplin"]
      interval: 5s
      retries: 10

  joplin:
    image: joplin/server:3.7.2
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      APP_PORT: "22300"
      APP_BASE_URL: http://localhost:22300
      DB_CLIENT: pg
      POSTGRES_HOST: postgres
      POSTGRES_PORT: "5432"
      POSTGRES_DATABASE: joplin
      POSTGRES_USER: joplin
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?}
    ports:
      - "22300:22300"

  joplin-mcp:
    image: joplin-mcp:latest
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      JOPLIN_DB_HOST: postgres
      JOPLIN_DB_NAME: joplin
      JOPLIN_DB_USER: joplin
      JOPLIN_DB_PASSWORD: ${POSTGRES_PASSWORD:?}
      MCP_API_KEY: ${MCP_API_KEY:?set MCP_API_KEY}
    ports:
      - "8000:8000"

volumes:
  pgdata:
```

```bash
cp .env.example .env    # set POSTGRES_PASSWORD and MCP_API_KEY, then:
docker compose up -d
```

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
      "headers": { "Authorization": "Bearer {env:JOPLIN_API_KEY}" }
    }
  }
}
```

Claude Code:

```bash
claude mcp add --transport http joplin http://localhost:8000/mcp \
  --header "Authorization: Bearer $JOPLIN_API_KEY"
```

Ask the agent to “summarize my open todos in Joplin”: it calls `list_todos`, then `get_note`.

## MCP tools (37)

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

| Variable             | Default               | Description                                                                              |
| -------------------- | --------------------- | ---------------------------------------------------------------------------------------- |
| `JOPLIN_DB_HOST`     | `pgsql`               | PostgreSQL host                                                                          |
| `JOPLIN_DB_PORT`     | `5432`                | PostgreSQL port                                                                          |
| `JOPLIN_DB_NAME`     | `joplin`              | Database name                                                                            |
| `JOPLIN_DB_USER`     | `postgres`            | Database user — needs read/write on `items`, `changes_2`, `user_items`, `item_resources` |
| `JOPLIN_DB_PASSWORD` | `postgres`            | Database password                                                                        |
| `JOPLIN_USER_ID`     | first user            | Joplin account the server acts for (see the `users` query above)                         |
| `MCP_API_KEY`        | *(empty)*             | Bearer key required on every route except `/health` and `/`                              |
| `MCP_PORT`           | `8000`                | HTTP listening port                                                                      |
| `MCP_PUBLIC_URL`     | maintainer's instance | Base URL advertised in tool output and download links — set it explicitly                |

> Leaving `MCP_API_KEY` empty disables authentication. Keep it set on anything reachable from
> outside `localhost` (hardening is tracked in [KANBAN.md](KANBAN.md)).

## How writes work

Every mutation writes the item body, one `changes_2` event (`type` 1 create / 2 update / 3 delete,
`item_type` 2 on create and 1 on update) and, when creating, the `user_items` ownership row. Deletions
are soft (`deleted_time`), attachments keep their binary until a client purges the trash, and a
replacement rewrites the blob in place so that `:/` links in note bodies survive.

The exact shapes, the ones real clients write in Joplin 3.7.2, live in
[docs/sync-shapes.md](docs/sync-shapes.md).

## Development

```bash
npm install
npm run build     # tsc → dist/
npm start         # node dist/index.js (reads the environment above)
```

The source is a single file today (`src/index.ts`, ~2 250 lines); splitting it into modules comes with
the test suite ([KANBAN.md](KANBAN.md)).

Working on the write path means testing against a real database: every change is verified on a
disposable notebook, note and attachment, then purged so that no residue remains.

## Out of scope

Assumed and documented, not accidental: E2EE and master keys, shares and collaboration, ENEX import,
settings, manual ordering (`order`), pinning, server-side trash purge (clients own it), and automatic
restore of a history version.

## Roadmap

Open work only, in [KANBAN.md](KANBAN.md); released history in [CHANGELOG.md](CHANGELOG.md).

## License

MIT — see [LICENSE](LICENSE).
