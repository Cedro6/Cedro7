"use server";

import { redirect } from "next/navigation";
import { activeMemberCount, can, extraUsers, isPlanId, PLANS, productOf, type Interval } from "@bos/core";
import { billingFor, siteOrigin, storeSubscription } from "../../../../lib/billing";
import { requireSession } from "../../../../lib/session";
import { changeSubscription, createCheckout, getSubscription, portalUrl, StripeError, stripeConfigured } from "../../../../lib/stripe";

const back = (key: "notice" | "error", text: string, yearly = false) => `/settings/billing?${yearly ? "yearly=1&" : ""}${key}=${encodeURIComponent(text)}`;
const stripeTrouble = (error: unknown) => {
  console.error("billing: stripe call failed", error);
  return error instanceof StripeError && error.status < 500 ? `Stripe said: ${error.message}` : "Stripe could not be reached. Try again in a minute.";
};

/**
 * Chooses a plan. Without a subscription this goes to Stripe Checkout to take the card; with one,
 * the subscription moves to the new plan or period straight away and Stripe adjusts the charge.
 */
export async function choosePlan(planId: string, interval: Interval): Promise<void> {
  const { ctx, membership } = await requireSession({ billingAllowed: true });
  if (!can(ctx, "settings.manage")) redirect(back("error", "Only an owner or admin can change the plan."));
  if (!stripeConfigured()) redirect(back("error", "Billing is not switched on yet."));
  if (!isPlanId(planId) || (interval !== "month" && interval !== "year")) redirect(back("error", "Choose a plan."));
  const plan = PLANS[planId];
  if (plan.product !== productOf(membership.businessType ?? "distributor")) redirect(back("error", "That plan is for a different product."));
  const state = billingFor(membership);
  const people = await activeMemberCount(ctx);
  if (plan.extraUser === null && people > plan.includedUsers) {
    redirect(back("error", `The ${plan.name} plan includes ${plan.includedUsers} people and your team has ${people}. Suspend some people in Settings first, or choose a bigger plan.`, interval === "year"));
  }
  let target: string;
  try {
    if (state.subscriptionId && (state.phase === "active" || state.phase === "past_due")) {
      const sub = await getSubscription(state.subscriptionId);
      const updated = await changeSubscription(sub, planId, interval, extraUsers(planId, people));
      await storeSubscription(ctx.pool, ctx.orgId, updated, new Date());
      target = back("notice", `You're now on ${plan.name}, billed ${interval === "year" ? "yearly" : "monthly"}. Stripe adjusts the next charge for the days already paid.`, interval === "year");
    } else {
      target = await createCheckout({
        orgId: ctx.orgId, plan: planId, interval, extraUsers: extraUsers(planId, people), customerId: state.customerId,
        email: membership.userEmail ?? "", trialEndsAt: state.trialEndsAt, origin: await siteOrigin(),
      });
    }
  } catch (error) {
    target = back("error", stripeTrouble(error), interval === "year");
  }
  redirect(target);
}

/** Stripe's page for the card on file, past invoices and cancelling. */
export async function manageBilling(): Promise<void> {
  const { ctx, membership } = await requireSession({ billingAllowed: true });
  if (!can(ctx, "settings.manage")) redirect(back("error", "Only an owner or admin can manage billing."));
  const customer = billingFor(membership).customerId;
  if (!customer) redirect(back("error", "There is no card on file yet. Choose a plan first."));
  let target: string;
  try {
    target = await portalUrl(customer, `${await siteOrigin()}/settings/billing`);
  } catch (error) {
    target = back("error", stripeTrouble(error));
  }
  redirect(target);
}
