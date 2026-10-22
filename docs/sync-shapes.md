# Joplin Server 3.7.2 — write shapes used by this server

Every write here replicates the rows produced by the official desktop client, verified
against a production database (inspections on 2026-10-21/22). The sync client reads these
tables directly: a wrong shape means invisible or corrupt items on the clients.

## Storage model

All syncable objects are rows of `items` (one table, `jop_type` discriminates):

| jop_type | object | `name` | `mime_type` | notes |
| -------- | ------ | ------ | ----------- | ----- |
| 0 | resource **blob** | `.resource/<jop_id>` | `''` | `jop_id=''`, `jop_parent_id=''`, `jop_share_id=''`, `jop_updated_time=0`, `content` = raw bytes |
| 1 | note | `<jop_id>.md` | `text/markdown` | JSON body |
| 2 | notebook (folder) | `<jop_id>.md` | `text/markdown` | JSON body |
| 4 | resource metadata | `<jop_id>.md` | `text/markdown` | JSON body, `title` = file name |
| 5 | tag | `<jop_id>.md` | `text/markdown` | JSON body |
| 6 | note↔tag relation | `<jop_id>.md` | `text/markdown` | `{tag_id, note_id}` (32-hex jop ids) |
| 13 | server-side note history | `<jop_id>.md` | `text/markdown` | written by the server only — never create one |

Constraints: `UNIQUE(name, owner_id)`, `UNIQUE(id)`, `content_storage_id = 1` (database
storage; `STORAGE_DRIVER` unset in the stack).

## Note JSON

Fields observed on real rows: `title`, `body`, `source`, `source_url`, `source_application`,
`markup_language` (1 = markdown), `is_todo`, `todo_due`, `todo_completed`, `order`,
`application_data`, `user_data`, `is_shared`, `is_locked`, `master_key_id`,
`encryption_cipher_text`, `conflict_original_id`, `is_conflict`, `deleted_time`,
`user_created_time`, `user_updated_time`, `created_time`, `extracted_resource_ids`,
`author`, `latitude`, `longitude`, `altitude`.

`update_note` merges unknown fields back (semantics preserved); `user_updated_time` is
always refreshed. `extracted_resource_ids` is filled by the server on save, not needed on
write.

## Todos (checklists and reminders)

A todo is a note with `is_todo = 1`; `todo_due` and `todo_completed` hold epoch milliseconds
(`0` = unset). There is no alarm item type in Joplin Server — a reminder is exactly a todo
with a `todo_due` date, the client schedules the notification. Turning a note back into a
plain note clears the three fields. Marking done writes the current time in
`todo_completed`; reopening sets it back to `0`.

## Replacing an attachment's content

The bytes are updated in place: the blob row keeps its `id` and `name`
(`.resource/<jop_id>`), the metadata keeps its `id` and `jop_id`. That is what makes a replace
safe — every `:/` link already written in note bodies keeps resolving. Refresh `size`, `mime`,
`file_extension`, `blob_updated_time` and `user_updated_time` in the metadata, `content` /
`content_size` / `updated_time` in the blob row (leave the blob's `jop_updated_time` at 0, as the
desktop writes it), then write one update change per row (type 2, `item_type` 1).

## Resources (attachments)

Metadata item (`jop_type=4`) JSON: `{is_locked, ocr_*, blob_updated_time, user_data,
master_key_id, is_shared, size, encryption_blob_encrypted, encryption_cipher_text,
file_extension, user_updated_time, user_created_time, created_time, filename, mime, title}`.

The bytes live in a **separate** `jop_type=0` row named `.resource/<jop_id>` with its own
`changes_2` and `user_items` rows. Both rows are created on upload; the note body then
carries a markdown link `[label](:/<jop_id 32hex>)` (image: leading `!`).

`item_resources` (columns `id` serial, `item_id` = note `items.id`, `resource_id` = resource
`jop_id`) is a **derived index** maintained by the server from note bodies. Writes here must
maintain it manually on attach/unlink. Postgres cannot infer parameter types across
`INSERT … SELECT … WHERE NOT EXISTS`, so cast explicitly (`$1::varchar`).

## Tags

Tag item (`jop_type=5`): `{user_data, is_shared, encryption_cipher_text, user_updated_time,
user_created_time, created_time, title}`.
Assignment is a relation item (`jop_type=6`): `{is_shared, encryption_cipher_text,
user_updated_time, user_created_time, created_time, tag_id, note_id}` — detachment is a soft
delete (`deleted_time`) plus a type-3 change.

## Trash lifecycle

Deletion is **soft**: `deleted_time = <now>` in the item JSON (note, resource metadata) and a
change of type 3. The blob row stays untouched until a client empties the trash — that is
when real blob rows disappear and the corresponding `.resource/<jop_id>` type-3 changes are
written. Restore clears `deleted_time` and records an update change; ids (hence note links)
survive.

## Sync events (`changes_2`)

Columns: `id, item_id, user_id, item_name, previous_share_id, item_type, type, updated_time,
created_time`.

- `type`: 1 = created, 2 = updated, 3 = deleted.
- `item_type`: 2 for created note/resource/tag/blob rows, 1 for updates (folders use 1). The
  client ignores this field in practice, but rows are written in both shapes by real
  clients — mirror the observed values.
- `item_name`: `<jop_id>.md`, or `.resource/<jop_id>` for blobs.
- `user_items` must contain the item id for the owning user, otherwise the item is invisible.

## Server-side note history (`jop_type=13`)

Written by the server on item saves: `{is_locked, created_time, encryption_cipher_text,
metadata_diff, body_diff, title_diff, item_updated_time, item_id, item_type}`. Read-only for
us (`get_note_history`); restoring means recomposing diffs — deliberately left to
`update_note` instead.

## Operational gotchas

- `pg` returns `bigint` columns as **strings**: coerce before building dates.
- `express.json()` defaults to 100 kB; `/mcp` accepts 48 MB (inline base64 cap 32 MiB).
- Binary transfer uses the same Bearer auth: `GET /files/<id>`, `POST /files`, `PUT /files/<id>`
  (raw body, 256 MB cap, `express.raw` on those routes only).
- Deleting `item_resources` rows by hand is unnecessary on resource deletion: the index
  reflects note bodies, and a trashed resource can be restored.
