import { withTenant } from "@bos/db/runtime";
import type { Ctx } from "../platform/context";
import { ValidationError } from "../platform/errors";
import type { Product } from "../platform/features";

/**
 * What each plan costs and allows. Prices are whole US dollars a month; a year costs ten months
 * (two months free). Companies on a plan with an extra-user price may go past the included users
 * and pay for each one; the others stop at their limit.
 */
export const PLAN_IDS = ["cedro_basic", "cedro_small", "cedro_corporate", "dealer"] as const;
export type PlanId = (typeof PLAN_IDS)[number];
export const isPlanId = (v: string): v is PlanId => (PLAN_IDS as readonly string[]).includes(v);
export type Interval = "month" | "year";

export type Plan = {
  id: PlanId;
  product: Product;
  name: string;
  monthly: number;
  includedUsers: number;
  /** Price a month for each user over the included number, or null when the plan stops there. */
  extraUser: number | null;
  /** Questions Ava answers for the whole company each month. */
  avaQuestions: number;
  blurb: string;
};

export const PLANS: Record<PlanId, Plan> = {
  cedro_basic: { id: "cedro_basic", product: "cedro", name: "Basic", monthly: 39, includedUsers: 3, extraUser: null, avaQuestions: 300, blurb: "For a small team getting organised" },
  cedro_small: { id: "cedro_small", product: "cedro", name: "Small business", monthly: 89, includedUsers: 10, extraUser: null, avaQuestions: 1000, blurb: "For a growing business with a few departments" },
  cedro_corporate: { id: "cedro_corporate", product: "cedro", name: "Corporate", monthly: 199, includedUsers: 25, extraUser: 8, avaQuestions: 3000, blurb: "For larger teams; add people as you grow" },
  dealer: { id: "dealer", product: "dealer", name: "Dealer Terminal", monthly: 99, includedUsers: 10, extraUser: 8, avaQuestions: 1000, blurb: "Everything for a Florida cash lot" },
};
export const plansFor = (product: Product): Plan[] => PLAN_IDS.map((id) => PLANS[id]).filter((p) => p.product === product);
export const yearlyPrice = (plan: Plan) => plan.monthly * 10;
export const TRIAL_DAYS: Record<Product, number> = { cedro: 14, dealer: 30 };
/** While trying the product out: enough people and questions to judge it, not to run a business on for free. */
export const TRIAL_LIMITS = { users: 10, avaQuestions: 200 };

/** Stripe's name for each price, so the same price is found again instead of being made twice. */
export const lookupKey = (plan: PlanId, interval: Interval, extra = false) => `${plan}_${extra ? "extra_user_" : ""}${interval}`;

export type BillingRow = {
  exempt: boolean;
  trialEndsAt: Date | null;
  plan: PlanId | null;
  interval: Interval | null;
  status: string | null;
  customerId: string | null;
  subscriptionId: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
};

export type BillingState = BillingRow & {
  /** False while no Stripe key is set: nothing is limited or locked, so the service never shuts people out by accident. */
  enabled: boolean;
  /** trial, active (paid up), past_due (a payment failed, Stripe is retrying), ended (trial over or subscription gone), exempt. */
  phase: "exempt" | "trial" | "active" | "past_due" | "ended";
  locked: boolean;
  trialDaysLeft: number | null;
  userLimit: number | null;
  /** Users beyond the plan's included number are charged for, rather than refused. */
  extraUsersBilled: boolean;
  avaQuestions: number;
};

const PAID = new Set(["active", "trialing"]);
const RETRYING = new Set(["past_due"]);

/** Works out where a company stands from what is stored. Pure, so it is tested without a database. */
export function billingState(row: BillingRow, options: { enabled: boolean; now?: Date; defaultAvaQuestions: number }): BillingState {
  const now = options.now ?? new Date();
  const plan = row.plan ? PLANS[row.plan] : null;
  const subscribed = Boolean(plan && row.status && (PAID.has(row.status) || RETRYING.has(row.status)));
  const trialDaysLeft = row.trialEndsAt ? Math.max(0, Math.ceil((row.trialEndsAt.getTime() - now.getTime()) / 86_400_000)) : null;
  const inTrial = !subscribed && row.trialEndsAt !== null && row.trialEndsAt.getTime() > now.getTime();
  const phase: BillingState["phase"] = !options.enabled || row.exempt ? "exempt" : subscribed ? (RETRYING.has(row.status!) ? "past_due" : "active") : inTrial ? "trial" : "ended";
  const unlimited = phase === "exempt";
  return {
    ...row,
    enabled: options.enabled,
    phase,
    locked: phase === "ended",
    trialDaysLeft: phase === "trial" ? trialDaysLeft : null,
    userLimit: unlimited ? null : subscribed && plan ? (plan.extraUser === null ? plan.includedUsers : null) : TRIAL_LIMITS.users,
    extraUsersBilled: !unlimited && subscribed && plan?.extraUser !== null && plan !== null,
    avaQuestions: unlimited ? options.defaultAvaQuestions : subscribed && plan ? plan.avaQuestions : TRIAL_LIMITS.avaQuestions,
  };
}

/** Extra users to bill: active people beyond what the plan includes. */
export const extraUsers = (plan: PlanId, activeUsers: number) => Math.max(0, activeUsers - PLANS[plan].includedUsers);

/** Refuses a new or returning team member when the plan is full. */
export function checkRoomForMember(state: BillingState, activeUsers: number): void {
  if (state.userLimit !== null && activeUsers >= state.userLimit) {
    const plan = state.plan ? PLANS[state.plan] : null;
    throw new ValidationError(
      "email",
      state.phase === "trial"
        ? `The free trial allows ${state.userLimit} people. Choose a plan in Settings, Billing to add more.`
        : `The ${plan?.name ?? "current"} plan includes ${state.userLimit} people. Move to a bigger plan in Settings, Billing to add more.`,
    );
  }
}

const COLUMNS = `billing_exempt as exempt, trial_ends_at as "trialEndsAt", plan, billing_interval as interval, subscription_status as status,
  stripe_customer_id as "customerId", stripe_subscription_id as "subscriptionId", current_period_end as "currentPeriodEnd", cancel_at_period_end as "cancelAtPeriodEnd"`;

export async function readBilling(ctx: Pick<Ctx, "pool" | "orgId">): Promise<BillingRow> {
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const r = await tx.query<BillingRow>(`select ${COLUMNS} from organizations where id = $1`, [ctx.orgId]);
    return r.rows[0]!;
  });
}

export async function activeMemberCount(ctx: Pick<Ctx, "pool" | "orgId">): Promise<number> {
  return withTenant(ctx.pool, ctx.orgId, async (tx) => (await tx.query<{ n: number }>("select count(*)::int as n from memberships where status = 'active'")).rows[0]!.n);
}

/** The customer Stripe made for the company, kept so the next checkout and the card portal find them. */
export async function saveStripeCustomer(ctx: Pick<Ctx, "pool" | "orgId">, customerId: string): Promise<void> {
  await withTenant(ctx.pool, ctx.orgId, (tx) => tx.query("update organizations set stripe_customer_id = $2, updated_at = now() where id = $1 and stripe_customer_id is null", [ctx.orgId, customerId]));
}

export type SubscriptionUpdate = {
  orgId: string;
  customerId: string;
  subscriptionId: string;
  status: string;
  plan: PlanId;
  interval: Interval;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  /** When Stripe produced this state. An older one never replaces a newer one. */
  at: Date;
};

/**
 * Stores Stripe's view of a company's subscription. Called from the signed notification and after
 * checkout. Refuses a customer id that belongs to a different company.
 */
export async function applySubscription(pool: Ctx["pool"], u: SubscriptionUpdate): Promise<boolean> {
  return withTenant(pool, u.orgId, async (tx) => {
    const r = await tx.query(
      `update organizations set plan = $2, billing_interval = $3, subscription_status = $4, stripe_customer_id = $5, stripe_subscription_id = $6,
              current_period_end = $7, cancel_at_period_end = $8, stripe_updated_at = $9, updated_at = now()
        where id = $1 and (stripe_customer_id is null or stripe_customer_id = $5) and (stripe_updated_at is null or stripe_updated_at <= $9)`,
      [u.orgId, u.plan, u.interval, u.status, u.customerId, u.subscriptionId, u.currentPeriodEnd, u.cancelAtPeriodEnd, u.at],
    );
    if ((r.rowCount ?? 0) > 0) {
      await tx.query(
        "insert into audit_log (org_id, actor_type, actor_id, action, entity_type, entity_id, after) values ($1, 'system', null, 'billing.subscription', 'organization', $1, $2)",
        [u.orgId, JSON.stringify({ plan: u.plan, interval: u.interval, status: u.status, cancelAtPeriodEnd: u.cancelAtPeriodEnd })],
      );
    }
    return (r.rowCount ?? 0) > 0;
  });
}
