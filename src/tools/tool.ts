import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

type StrictObject<Shape extends z.ZodRawShape> = z.ZodObject<{ -readonly [P in keyof Shape]: Shape[P] }, z.core.$strict>;

/**
 * Register a tool whose arguments are validated against a *strict* object
 * schema.
 *
 * The deprecated `server.tool(name, description, shape, cb)` API validates a
 * raw shape with `z.object(shape)`, which **strips unknown keys**: a caller
 * that misspells a field (`content` instead of `body`) gets no error at all and
 * sees the tool answer normally, so the write is silently ignored. Every tool
 * of this server therefore registers here, where a stray field raises an
 * `InvalidParams` protocol error naming the offending key.
 *
 * `annotations` is mandatory and written **as a literal at the call site**, not
 * through a shared constant: directory scanners and reviewers read the tool
 * declaration itself, and a hint they cannot see there counts as missing for
 * them, whatever the helper does at runtime.
 *
 * Each tool declares all four hints:
 *
 * - reads (`list_*`, `get_*`, `search_*`, `download_*`):
 *   `readOnlyHint: true, destructiveHint: false, idempotentHint: true`;
 * - creates (`create_*`, `add_*`): `idempotentHint: false`, the call adds a new
 *   item every time;
 * - edits (`update_*`, `move_*`, `attach_*`, `unlink_*`, `rename_*`,
 *   `restore_item`): `destructiveHint: false, idempotentHint: true`, repeating
 *   the call lands on the same state;
 * - deletes (`delete_*`): `destructiveHint: true`, the item goes to the trash;
 *   still idempotent, a second call is a no-op.
 *
 * `openWorldHint` is `true` everywhere: the server reads and writes a live
 * Joplin database that other clients share.
 */
export const defineTool = <Shape extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  annotations: ToolAnnotations,
  shape: Shape,
  handler: ToolCallback<StrictObject<Shape>>,
): void => {
  server.registerTool(name, { description, inputSchema: z.object(shape).strict(), annotations }, handler);
};
