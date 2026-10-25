import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

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
 */
export const defineTool = <Shape extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  shape: Shape,
  handler: ToolCallback<z.ZodObject<Shape, "strict">>,
): void => {
  server.registerTool<z.ZodRawShape, z.ZodObject<Shape, "strict">>(name, { description, inputSchema: z.object(shape).strict() }, handler);
};
