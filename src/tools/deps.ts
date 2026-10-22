import type { Store } from "../store/index.js";

/**
 * What a tool module receives. Handlers never see a `pg` pool: every database
 * access goes through `store`, so a fake store is enough to exercise them.
 */
export interface ToolDeps {
  store: Store;
  /** Absolute MCP endpoint, written inside attachment links. */
  publicUrl: string;
}
