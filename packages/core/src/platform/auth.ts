import { withTenant, type Pool } from "@bos/db/runtime";
import { isRole, type Role } from "./permissions";

export type Membership = { userId: string; userName: string; orgId: string; orgName: string; role: Role };

/** The companies a person belongs to, looked up by email at sign-in. */
export async function membershipsByEmail(pool: Pool, email: string): Promise<Membership[]> {
  const result = await pool.query<{
    user_id: string;
    user_name: string;
    org_id: string;
    org_name: string;
    role: string;
  }>("select * from auth_memberships_by_email($1)", [email]);
  return result.rows.flatMap((row) =>
    isRole(row.role)
      ? [{ userId: row.user_id, userName: row.user_name, orgId: row.org_id, orgName: row.org_name, role: row.role }]
      : [],
  );
}

/** Re-reads the person's current role on every request, so a role change or suspension applies at once. */
export async function currentMembership(pool: Pool, orgId: string, userId: string): Promise<Membership | null> {
  return withTenant(pool, orgId, async (tx) => {
    const result = await tx.query<{ user_name: string; org_name: string; role: string }>(
      `select u.name as user_name, o.name as org_name, m.role
       from memberships m
       join users u on u.id = m.user_id
       join organizations o on o.id = m.org_id
       where m.user_id = $1 and m.status = 'active'`,
      [userId],
    );
    const row = result.rows[0];
    if (!row || !isRole(row.role)) return null;
    return { userId, userName: row.user_name, orgId, orgName: row.org_name, role: row.role };
  });
}
