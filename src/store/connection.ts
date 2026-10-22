import { Pool } from "pg";

/** PostgreSQL coordinates, as read from the environment. */
export interface DbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export function readDbConfig(env: NodeJS.ProcessEnv = process.env): DbConfig {
  return {
    host: env.JOPLIN_DB_HOST || "pgsql",
    port: Number.parseInt(env.JOPLIN_DB_PORT || "5432", 10),
    database: env.JOPLIN_DB_NAME || "joplin",
    user: env.JOPLIN_DB_USER || "postgres",
    password: env.JOPLIN_DB_PASSWORD || "postgres",
  };
}

/** The only place a `pg` pool is created; everything else goes through a store. */
export function createPool(config: DbConfig): Pool {
  return new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
}
