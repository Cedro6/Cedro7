import { withTenant, type Pool } from "@bos/db/runtime";
import { effectiveFeatures, isBusinessType, parseFeatures, type BusinessType, type FeatureSet } from "./features";
import { DEFAULT_CURRENCY, DEFAULT_TIME_ZONE, isCurrency, isTimeZone } from "./locale";
import { isRole, type Role } from "./permissions";
import { isPlanId, type BillingRow } from "../billing/plans";

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
  /** The company's plan, trial and subscription, as last told by Stripe. */
  billing?: BillingRow;
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
    const result = await tx.query<{ user_name: string; org_name: string; role: string; business_type: string; features: unknown; timezone: string; currency: string; email: string; suspended: boolean; require_two_step: boolean;
      billing_exempt: boolean; trial_ends_at: Date | null; plan: string | null; billing_interval: string | null; subscription_status: string | null; stripe_customer_id: string | null; stripe_subscription_id: string | null; current_period_end: Date | null; cancel_at_period_end: boolean }>(
      `select u.email, o.suspended_at is not null as suspended, o.require_two_step,
              o.billing_exempt, o.trial_ends_at, o.plan, o.billing_interval, o.subscription_status, o.stripe_customer_id, o.stripe_subscription_id, o.current_period_end, o.cancel_at_period_end, u.name as user_name, o.name as org_name, m.role, o.business_type, o.features, o.timezone, trim(o.base_currency) as currency
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
      features: effectiveFeatures(isBusinessType(row.business_type) ? row.business_type : "distributor", parseFeatures(row.features)),
      timeZone: isTimeZone(row.timezone) ? row.timezone : DEFAULT_TIME_ZONE,
      currency: isCurrency(row.currency) ? row.currency : DEFAULT_CURRENCY,
      billing: {
        exempt: row.billing_exempt, trialEndsAt: row.trial_ends_at, plan: row.plan && isPlanId(row.plan) ? row.plan : null,
        interval: row.billing_interval === "month" || row.billing_interval === "year" ? row.billing_interval : null, status: row.subscription_status,
        customerId: row.stripe_customer_id, subscriptionId: row.stripe_subscription_id, currentPeriodEnd: row.current_period_end, cancelAtPeriodEnd: row.cancel_at_period_end,
      },
    };
  });
}
