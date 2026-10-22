# Security Policy

## What this server can do

`joplin-mcp` holds a **read/write credential on the Joplin database**. Anyone who can reach it with
a valid Bearer key can read, modify, trash and restore every note, attachment and tag of the
configured account. Treat the key and the database password as production secrets.

The threat model is deliberately narrow: a single user, a single Joplin account (`JOPLIN_USER_ID`),
one shared Bearer key, no multi-tenant isolation, no encryption of its own (it writes plaintext rows,
which is why it is incompatible with E2EE).

## Guard rails in place

- **Fail closed**: the process exits at startup when `MCP_API_KEY` is missing, empty or still set to
  the `change-me` placeholder.
- **Constant-time comparison**: the Bearer token is compared through SHA-256 digests with
  `crypto.timingSafeEqual`.
- **Public routes only**: `/health` and `/` need no key (so a container healthcheck needs no secret);
  everything else, including the `/files` binary routes, requires it.
- **Parameterised SQL** everywhere: no user input is interpolated into a statement.
- **Soft deletes**: destructive operations go through the Joplin trash, `restore_item` keeps ids, and
  a resource cannot be deleted while a note still links it unless `force` is passed.

## Reporting a vulnerability

Do not open a public issue. Send a mail to [openhoat@gmail.com](mailto:openhoat@gmail.com) with the steps to reproduce and the
impact; a fix and a coordinated disclosure will follow. Please allow a few days before publishing
anything.

## Supported versions

The project ships as a rolling `latest` tag; security fixes land on the last released minor version.
The database shapes it relies on are documented in [docs/sync-shapes.md](docs/sync-shapes.md) and were
verified against Joplin Server 3.7.2 — a Joplin upgrade that changes the sync schema can break the
server in ways that are not security issues but may corrupt items. Back up before upgrading either
side.
