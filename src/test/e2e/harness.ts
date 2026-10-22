/**
 * Support code for the end-to-end suite: an MCP client over HTTP, a PostgreSQL
 * helper that inspects and purges the rows a run created.
 *
 * Nothing here is mocked. The point of this suite is to exercise the real
 * handlers against the real Joplin schema — a fake pool would only assert that
 * the mock was called.
 */

import { readFileSync } from "node:fs";
import { Client } from "pg";

export interface E2eConfig {
  mcpUrl: string;
  apiKey: string;
  db: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  };
}

/**
 * Read the suite configuration. Returns `null` when the secrets are absent:
 * the suite then skips instead of failing, so `npm test` and a plain checkout
 * stay green without a stack.
 */
export function readConfig(): E2eConfig | null {
  const apiKey = process.env.E2E_API_KEY ?? "";
  const password = process.env.E2E_DB_PASSWORD ?? "";
  if (!apiKey || !password) {
    return null;
  }
  return {
    mcpUrl: (process.env.E2E_MCP_URL ?? "http://127.0.0.1:8000").replace(/\/+$/, ""),
    apiKey,
    db: {
      host: process.env.E2E_DB_HOST ?? "127.0.0.1",
      port: Number(process.env.E2E_DB_PORT ?? "15432"),
      user: process.env.E2E_DB_USER ?? "joplin",
      password,
      database: process.env.E2E_DB_NAME ?? "joplin",
    },
  };
}

export interface ToolCall {
  text: string;
  isError: boolean;
}

export class McpClient {
  private sequence = 0;

  constructor(private readonly config: E2eConfig) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
  }

  /** Raw JSON-RPC exchange, used for the transport-level assertions. */
  async request(payload: unknown, headers: Record<string, string> = this.headers()): Promise<Response> {
    return fetch(`${this.config.mcpUrl}/mcp`, { method: "POST", headers, body: JSON.stringify(payload) });
  }

  /** Call one tool and flatten the MCP envelope into text + error flag. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolCall> {
    const response = await this.request({
      jsonrpc: "2.0",
      id: ++this.sequence,
      method: "tools/call",
      params: { name, arguments: args },
    });
    if (response.status !== 200) {
      throw new Error(`${name}: HTTP ${response.status} ${await response.text()}`);
    }
    const body = (await response.json()) as {
      error?: unknown;
      result?: { content?: Array<{ text?: string }>; isError?: boolean };
    };
    if (body.error) {
      throw new Error(`${name}: ${JSON.stringify(body.error)}`);
    }
    const result = body.result ?? {};
    return { text: result.content?.[0]?.text ?? "", isError: result.isError === true };
  }
}

/** Package version, so the test can assert what `initialize` advertises. */
export function packageVersion(): string {
  const raw = readFileSync(new URL("../../../package.json", import.meta.url), "utf8");
  return (JSON.parse(raw) as { version: string }).version;
}

/** `ID: xxx` printed by the create tools. */
export function itemId(text: string): string {
  const match = text.match(/ID: (\w+)/);
  if (!match) {
    throw new Error(`no ID in tool output: ${text.slice(0, 200)}`);
  }
  return match[1];
}

/** `jop_id: <32 hex>` printed by some tools. */
export function jopId(text: string): string {
  const match = text.match(/jop_id: ([0-9a-f]{32})/);
  if (!match) {
    throw new Error(`no jop_id in tool output: ${text.slice(0, 200)}`);
  }
  return match[1];
}

export async function connectDatabase(config: E2eConfig): Promise<Client> {
  const client = new Client(config.db);
  await client.connect();
  return client;
}

export interface PurgeTargets {
  ids: string[];
  jopIds: string[];
}

/**
 * Expand what a run created into every row that has to disappear: the items
 * themselves, the `.resource/<jop_id>` blobs, the relations that mention them
 * and the history entries that point at them.
 */
export async function resolveTargets(client: Client, ids: string[]): Promise<PurgeTargets> {
  const direct = await client.query("SELECT id, jop_id FROM items WHERE id = ANY($1::text[])", [ids]);
  const jopIds: string[] = direct.rows.map((row) => row.jop_id);
  const collected = new Set<string>(direct.rows.map((row) => row.id));

  const blobs = await client.query("SELECT id FROM items WHERE name = ANY($1::text[])", [jopIds.map((id) => `.resource/${id}`)]);
  for (const row of blobs.rows) {
    collected.add(row.id);
  }

  if (jopIds.length > 0) {
    const mentioned = jopIds.map((id) => `%${id}%`);
    const related = await client.query(
      "SELECT id FROM items WHERE jop_type IN (6, 13) AND (encode(content, 'escape') LIKE ANY($1::text[]))",
      [mentioned],
    );
    for (const row of related.rows) {
      collected.add(row.id);
    }
  }

  return { ids: [...collected], jopIds };
}

/** Hard delete, exactly the recipe documented for cleaning a disposable run. */
export async function purgeTargets(client: Client, targets: PurgeTargets): Promise<void> {
  if (targets.ids.length === 0) {
    return;
  }
  await client.query("BEGIN");
  try {
    await client.query("DELETE FROM item_resources WHERE item_id = ANY($1::text[]) OR resource_id = ANY($2::text[])", [
      targets.ids,
      targets.jopIds,
    ]);
    await client.query("DELETE FROM user_items WHERE item_id = ANY($1::text[])", [targets.ids]);
    await client.query("DELETE FROM changes_2 WHERE item_id = ANY($1::text[])", [targets.ids]);
    await client.query("DELETE FROM items WHERE id = ANY($1::text[])", [targets.ids]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

/**
 * Any surviving row for the ids of the run, or any row whose content still
 * carries the run prefix. Every counter must be zero before the run is clean.
 */
export async function countResidue(client: Client, targets: PurgeTargets, prefix: string): Promise<Record<string, number>> {
  const count = async (sql: string, params: unknown[]): Promise<number> => {
    const result = await client.query(sql, params);
    return Number(result.rows[0].count);
  };
  return {
    items: await count("SELECT count(*)::int AS count FROM items WHERE id = ANY($1::text[])", [targets.ids]),
    changes: await count("SELECT count(*)::int AS count FROM changes_2 WHERE item_id = ANY($1::text[])", [targets.ids]),
    ownership: await count("SELECT count(*)::int AS count FROM user_items WHERE item_id = ANY($1::text[])", [targets.ids]),
    links: await count("SELECT count(*)::int AS count FROM item_resources WHERE item_id = ANY($1::text[])", [targets.ids]),
    content: await count("SELECT count(*)::int AS count FROM items WHERE encode(content, 'escape') LIKE $1", [`%${prefix}%`]),
  };
}
