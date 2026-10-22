/**
 * The store seam: everything PostgreSQL lives behind this interface, so a tool
 * handler can be exercised with a fake implementation and no database.
 *
 * `createStore` is the only place that knows how the pieces are assembled; the
 * tool layer receives the resulting object and never sees a `pg` pool.
 */

import type { Pool } from "pg";
import { type Core, createCore } from "./core.js";
import { createHistoryStore, type HistoryStore } from "./history.js";
import { createNotebookStore, type NotebookStore } from "./notebooks.js";
import { createNoteStore, type NoteStore } from "./notes.js";
import { createResourceStore, type ResourceStore } from "./resources.js";
import { createTagStore, type TagStore } from "./tags.js";
import { createTrashStore, type TrashStore } from "./trash.js";

export type { ChangeParams, Core } from "./core.js";
export type { HistoryStore } from "./history.js";
export type { NotebookStore } from "./notebooks.js";
export type { NoteStore } from "./notes.js";
export type { ResourceStore } from "./resources.js";
export type { TagStore } from "./tags.js";
export type { TrashStore } from "./trash.js";

export type Store = Core & ResourceStore & HistoryStore & NotebookStore & NoteStore & TagStore & TrashStore;

export function createStore(pool: Pool, pinnedUserId: string): Store {
  const { core } = createCore(pool, pinnedUserId);
  return {
    ...core,
    ...createResourceStore(pool, core),
    ...createTagStore(pool, core),
    ...createHistoryStore(pool),
    ...createNotebookStore(pool, core),
    ...createNoteStore(pool, core),
    ...createTrashStore(pool, core),
  };
}
