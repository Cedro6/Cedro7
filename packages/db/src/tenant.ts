import type { Pool, PoolClient } from "./client";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs `fn` in a transaction scoped to one company. Row-level security compares
 * every row to this setting, and the setting ends with the transaction.
 */
export async function withTenant<T>(pool: Pool, orgId: string, fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  if (!UUID.test(orgId)) throw new Error("withTenant: orgId must be a UUID");
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.org_id', $1, true)", [orgId]);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
