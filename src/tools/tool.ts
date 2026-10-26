import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

/**
 * The four behaviour hints hosts use to decide how to present a tool.
 *
 * All four are mandatory: the OpenAI app directory rejects a tool whose hints are
 * missing or not booleans, and a client cannot warn the user before a destructive
 * call when the server stays silent. Every tool therefore picks one of the
 * presets below instead of leaving `annotations` undefined.
 *
 * `openWorldHint` is `true` everywhere: the server reads and writes a live Joplin
 * database that other clients share, so outcomes depend on state the caller does
 * not control.
 */
export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/** Creates a new item per call: repeating it adds duplicates, hence not idempotent. */
export const CREATING: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

/** Edits an existing item without throwing anything away: repeating it lands on the same state. */
export const MUTATING: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/** Sends an item to the Joplin trash. Repeating it is a no-op, so still idempotent. */
export const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

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
 * The `annotations` parameter is explicit (no default) so that a new tool
 * cannot ship without its four behaviour hints.
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
