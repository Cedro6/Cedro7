import type { Pool } from "./client";

export const DEMO_ORG_SLUG = "harbor-supply";

/** Loads one demo company with an owner. Safe to run repeatedly. Runs as the owner role. */
export async function seed(owner: Pool): Promise<{ orgId: string; userId: string }> {
  const client = await owner.connect();
  try {
    await client.query("begin");
    const org = await client.query<{ id: string }>(
      `insert into organizations (name, slug) values ('Harbor Supply Co.', $1)
       on conflict (slug) do update set name = excluded.name
       returning id`,
      [DEMO_ORG_SLUG],
    );
    const user = await client.query<{ id: string }>(
      `insert into users (email, name) values ('amara@harborsupply.example', 'Amara Okafor')
       on conflict (email) do update set name = excluded.name
       returning id`,
    );
    const orgId = org.rows[0]!.id;
    const userId = user.rows[0]!.id;
    const membership = await client.query(
      `insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')
       on conflict (org_id, user_id) do nothing`,
      [orgId, userId],
    );
    if (membership.rowCount === 1) {
      await client.query(
        `insert into audit_log (org_id, actor_type, action, entity_type, entity_id, after)
         values ($1, 'system', 'seed.created', 'organization', $1, $2)`,
        [orgId, JSON.stringify({ slug: DEMO_ORG_SLUG })],
      );
    }
    await client.query("commit");
    return { orgId, userId };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
