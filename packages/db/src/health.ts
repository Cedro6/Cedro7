import type { Pool } from "./client";

export type Health = { ok: true; serverVersion: string } | { ok: false; error: string };

/** Connectivity check as the app role. Reads no tenant data. */
export async function health(app: Pool): Promise<Health> {
  try {
    const result = await app.query<{ v: string }>("select current_setting('server_version') as v");
    return { ok: true, serverVersion: result.rows[0]!.v };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
