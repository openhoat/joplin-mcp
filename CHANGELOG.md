# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.10.0] - 2026-10-22

### Added

- Unit test suite (39 tests) over the pure layer: Joplin content parsing and building, formatting,
  todo dates, history diffs, ids and markdown links. Coverage gate at 90 % of lines, statements and
  functions, 85 % of branches.
- GitHub Actions pipeline: biome, prettier and markdownlint, typecheck, tests with coverage, build,
  and a Docker image build on every push and pull request. CI badge in the README.
- npm scripts `qa`, `typecheck`, `test`, `test:coverage` and `validate`, so the local gate and the CI
  gate are the same command.

### Changed

- The pure helpers moved out of `src/index.ts` into `src/lib/` (337 lines less in the monolith), with
  no behaviour change: tool names, arguments and results are identical.
- Docker image rebuilt on `node:24-alpine` — the `node:20` base was out of support — in two stages,
  with `npm ci` against the lockfile instead of `npm install`; the runtime stage carries production
  dependencies only.

## [1.9.1] - 2026-10-22

### Fixed

- `create_note` prints the destination notebook title instead of its raw `jop_id`, so a caller can
  check where the note landed without a second lookup.

## [1.9.0] - 2026-10-22

### Changed

- **Agent-facing output is now English only**: every tool result, refusal and error message was
  rewritten (about 200 strings), with no emoji markers left. Tool names, arguments and item shapes
  are untouched — the MCP contract is stable, only the text changes.
- Failures are now flagged with `isError: true` (96 return paths) instead of being plain results, so
  an agent can tell "the note does not exist" from "the search returned nothing".
- Sizes use English units (`B`, `KB`, `MB`) and todo lines use `[ ]` / `[x]` instead of pictograms.

## [1.8.0] - 2026-10-22

### Changed

- **Breaking** — the server refuses to start without a real `MCP_API_KEY`: an empty value or the
  `change-me` placeholder exits with an explicit message. Until now an empty key silently disabled
  authentication on a process that reads and writes the notes database.
- `MCP_PUBLIC_URL` defaults to `http://localhost:<port>` and `build.sh` defaults to
  `ghcr.io/openhoat`, instead of pointing at the maintainer's private instance and registry.

### Security

- Bearer tokens are compared through SHA-256 digests with `crypto.timingSafeEqual`, which removes the
  early-exit comparison and the token-length leak. `/health` and `/` stay public for healthchecks,
  every other route (including the `/files` binary transfer) requires the key.

## [1.6.3] - 2026-10-22

### Fixed

- `get_note_history`: a creation entry is detected by the `id` field of its metadata diff (the
  creation diff carries no `created_time`), so it is summarised instead of listing 22 raw fields.

## [1.6.2] - 2026-10-22

### Fixed

- `get_note_history`: the creation entry of an item is collapsed into one line, and long field
  lists are truncated, instead of dumping the whole record on every note.

## [1.6.1] - 2026-10-22

### Fixed

- `get_note_history`: `metadata_diff` is stored as a JSON string while `title_diff` and
  `body_diff` are arrays; each diff is now parsed defensively, so the changed fields are reported.

## [1.6.0] - 2026-10-22

### Added

- `get_notebook_tree`: the notebook hierarchy as an indented tree, with a note count per notebook.
- `move_notebook`: move a notebook under another one or back to the root, refusing cycles.
- `list_conflicted_notes`: triage the notes Joplin flagged as sync conflicts.
- `get_note_history`: read-only server-side history of a note, with the diffs rendered as `+`/`-`
  fragments.

### Documentation

- `docs/sync-shapes.md`: folder hierarchy (parent stored twice) and note history shapes (item id,
  three different diff encodings, no history for direct database writes).

## [1.5.0] - 2026-10-22

### Added

- `update_resource` tool and `PUT /files/<id>` route: replace the binary content of an attachment
  in place. The resource id and `jop_id` are preserved, so every `:/` link already written in note
  bodies keeps resolving.

### Documentation

- `docs/sync-shapes.md`: the in-place replacement shape (metadata refresh, blob row update, one
  update event per row).

## [1.4.1] - 2026-10-22

### Fixed

- Note updates write `changes_2.item_type = 1`, as real clients do on update (2 136 desktop rows at
  1 against 135 at 2 before the fix), on `update_note` and on the body updates driven by attachments.

## [1.4.0] - 2026-10-22

### Added

- Todos: `is_todo`, `todo_due` and `todo_completed` on `create_note` and `update_note`, and
  `list_todos` to read them, scoped by notebook and sorted by due date.
- Tags: complete management — `list_notes_with_tag`, `rename_tag` (id kept, assignments survive)
  and `delete_tag` (trashes the tag and its assignments, never the notes).

## [1.3.0] - 2026-10-22

### Added

- `delete_resource` (soft delete, refused while a note still links the resource unless `force`),
  `list_trash` and `restore_item`. Restoring preserves the ids, so links stay intact.

### Changed

- `/mcp` accepts a 48 MB JSON body, to fit a 32 MiB file in base64.

### Fixed

- `item_resources` insert: explicit `$1::varchar` cast, the type inference silently dropped the row.
- `bigint` timestamps are coerced before being formatted (the driver returns strings).

## [1.2.0] - 2026-10-22

### Added

- Attachments: `list_note_attachments`, `list_resources`, `get_resource`, `download_resource`,
  `add_resource`, `attach_resource_to_note`, `unlink_resource_from_note`, plus the `GET /files/<id>`
  and `POST /files` binary routes (256 MB, same Bearer key as `/mcp`).
- Tags: `list_tags`, `add_tag`, `list_note_tags`, `attach_tag_to_note`, `detach_tag_from_note`.

## [1.1.1] - 2026-10-22

### Changed

- Imported from the `docker-stacks` monorepo into a dedicated repository, unchanged.

[1.10.0]: https://github.com/openhoat/joplin-mcp/compare/v1.9.1...v1.10.0
[1.9.1]: https://github.com/openhoat/joplin-mcp/compare/v1.9.0...v1.9.1
[1.9.0]: https://github.com/openhoat/joplin-mcp/compare/v1.8.0...v1.9.0
[1.8.0]: https://github.com/openhoat/joplin-mcp/compare/v1.6.3...v1.8.0
[1.6.3]: https://github.com/openhoat/joplin-mcp/compare/v1.6.2...v1.6.3
[1.6.2]: https://github.com/openhoat/joplin-mcp/compare/v1.6.1...v1.6.2
[1.6.1]: https://github.com/openhoat/joplin-mcp/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/openhoat/joplin-mcp/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/openhoat/joplin-mcp/compare/v1.4.1...v1.5.0
[1.4.1]: https://github.com/openhoat/joplin-mcp/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/openhoat/joplin-mcp/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/openhoat/joplin-mcp/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/openhoat/joplin-mcp/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/openhoat/joplin-mcp/releases/tag/v1.1.1
