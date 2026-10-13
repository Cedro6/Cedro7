import { withTenant, type Pool } from "@bos/db/runtime";
import { isBusinessType, parseFeatures, type BusinessType, type FeatureSet } from "./features";
import { DEFAULT_CURRENCY, DEFAULT_TIME_ZONE, isCurrency, isTimeZone } from "./locale";
import { isRole, type Role } from "./permissions";

export type Membership = {
  userId: string;
  userName: string;
  orgId: string;
  orgName: string;
  role: Role;
  /** Present when read for a signed-in request; the sign-in list does not need them. */
  businessType?: BusinessType;
  features?: FeatureSet;
  timeZone?: string;
  currency?: string;
  userEmail?: string;
  /** The company has been switched off by whoever runs the service. */
  suspended?: boolean;
  /** The company insists on two-step verification for everyone with a password. */
  requireTwoStep?: boolean;
};

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
    const result = await tx.query<{ user_name: string; org_name: string; role: string; business_type: string; features: unknown; timezone: string; currency: string; email: string; suspended: boolean; require_two_step: boolean }>(
      `select u.email, o.suspended_at is not null as suspended, o.require_two_step, u.name as user_name, o.name as org_name, m.role, o.business_type, o.features, o.timezone, trim(o.base_currency) as currency
       from memberships m
       join users u on u.id = m.user_id
       join organizations o on o.id = m.org_id
       where m.user_id = $1 and m.status = 'active'`,
      [userId],
    );
    const row = result.rows[0];
    if (!row || !isRole(row.role)) return null;
    return {
      userId,
      userName: row.user_name,
      userEmail: row.email,
      suspended: row.suspended,
      requireTwoStep: row.require_two_step,
      orgId,
      orgName: row.org_name,
      role: row.role,
      businessType: isBusinessType(row.business_type) ? row.business_type : "distributor",
      features: parseFeatures(row.features),
      timeZone: isTimeZone(row.timezone) ? row.timezone : DEFAULT_TIME_ZONE,
      currency: isCurrency(row.currency) ? row.currency : DEFAULT_CURRENCY,
    };
  });
}
