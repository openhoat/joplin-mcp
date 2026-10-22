/**
 * Server configuration and size limits.
 *
 * Everything comes from the environment, with defaults that match the compose
 * quick start. The limits are shared by the inline tool paths and the binary
 * HTTP endpoints so both reject a file at the same size.
 */

export const DEFAULT_INLINE_DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const HARD_INLINE_DOWNLOAD_MAX_BYTES = 32 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;
export const MCP_JSON_LIMIT = "48mb";

export interface ServerConfig {
  port: number;
  /** Bearer token guarding /mcp and /files; the process refuses to start without it. */
  apiKey: string;
  /** Absolute public endpoint, written inside attachment links. */
  publicUrl: string;
  /** Pin the Joplin account instead of resolving the oldest one. */
  pinnedUserId: string;
}

export function readServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number.parseInt(env.MCP_PORT || "8000", 10);
  return {
    port,
    apiKey: env.MCP_API_KEY || "",
    publicUrl: (env.MCP_PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, ""),
    pinnedUserId: env.JOPLIN_USER_ID || "",
  };
}
