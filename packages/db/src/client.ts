import pg from "pg";

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

/** Owner role: migrations, seeds and maintenance only. */
export function ownerUrl(): string {
  return process.env.DATABASE_URL_OWNER ?? "postgres://bos_owner:bos_owner@localhost:5432/bos_dev";
}

/** App role: what the product runs as. Subject to row-level security. */
export function appUrl(): string {
  return process.env.DATABASE_URL ?? "postgres://bos_app:bos_app@localhost:5432/bos_dev";
}

export function createPool(connectionString: string): Pool {
  return new pg.Pool({ connectionString, max: 5 });
}
