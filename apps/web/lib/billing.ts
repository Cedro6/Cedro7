import { headers } from "next/headers";
import { activeMemberCount, applySubscription, billingState, checkRoomForMember, extraUsers, type BillingState, type Ctx, type Membership } from "@bos/core";
import { monthlyLimit } from "./assistant";
import { changeSubscription, getSubscription, periodEnd, planOf, stripeConfigured, type StripeSubscription } from "./stripe";

const NONE = { exempt: true, trialEndsAt: null, plan: null, interval: null, status: null, customerId: null, subscriptionId: null, currentPeriodEnd: null, cancelAtPeriodEnd: false };

/** Where the signed-in company stands: trial, paid, payment failing, or ended. Billing is off without a Stripe key. */
export const billingFor = (membership: Membership): BillingState =>
  billingState(membership.billing ?? NONE, { enabled: stripeConfigured(), defaultAvaQuestions: monthlyLimit() });


/** The address of this site as the person is using it, for links back from Stripe. */
export async function siteOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/** Stores a Stripe subscription's state against the company it was made for. */
export async function storeSubscription(pool: Ctx["pool"], orgId: string, sub: StripeSubscription, at: Date): Promise<boolean> {
  const which = planOf(sub);
  if (!which) {
    console.error("billing: subscription has no known plan price", sub.id);
    return false;
  }
  return applySubscription(pool, {
    orgId, customerId: sub.customer, subscriptionId: sub.id, status: sub.status, plan: which.plan, interval: which.interval,
    currentPeriodEnd: periodEnd(sub), cancelAtPeriodEnd: sub.cancel_at_period_end, at,
  });
}

/** Refuses another active person when the plan is full. */
export async function ensureRoomForMember(ctx: Ctx, membership: Membership): Promise<void> {
  checkRoomForMember(billingFor(membership), await activeMemberCount(ctx));
}

/**
 * After people join or leave, sets the number of extra users the subscription pays for. If Stripe
 * cannot be reached the team change still stands; the count is put right on the next change.
 */
export async function syncSeats(ctx: Ctx, membership: Membership): Promise<void> {
  const state = billingFor(membership);
  if (!state.extraUsersBilled || !state.subscriptionId || !state.plan || !state.interval) return;
  try {
    const sub = await getSubscription(state.subscriptionId);
    const updated = await changeSubscription(sub, state.plan, state.interval, extraUsers(state.plan, await activeMemberCount(ctx)));
    await storeSubscription(ctx.pool, ctx.orgId, updated, new Date());
  } catch (error) {
    console.error("billing: could not update the number of extra users", error);
  }
}
