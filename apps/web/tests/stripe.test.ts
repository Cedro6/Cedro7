import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { planOf, periodEnd, verifyStripeSignature, type StripeSubscription } from "../lib/stripe";

const SECRET = "whsec_test_secret";
const sign = (body: string, t: number, secret = SECRET) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

describe("Stripe notifications", () => {
  const body = JSON.stringify({ type: "customer.subscription.updated", created: 1 });
  const now = 1_800_000_000_000;
  const t = now / 1000;

  it("accepts a correctly signed, recent notification", () => {
    expect(verifyStripeSignature(body, sign(body, t), SECRET, now)).toBe(true);
    // Stripe may send several signatures while a secret is being rolled; any valid one will do.
    expect(verifyStripeSignature(body, `${sign(body, t, "old")},v1=${sign(body, t).split("v1=")[1]}`, SECRET, now)).toBe(true);
  });

  it("refuses a changed body, the wrong secret, an old timestamp, or no signature at all", () => {
    expect(verifyStripeSignature(body.replace("updated", "deleted"), sign(body, t), SECRET, now)).toBe(false);
    expect(verifyStripeSignature(body, sign(body, t, "whsec_other"), SECRET, now)).toBe(false);
    expect(verifyStripeSignature(body, sign(body, t - 600), SECRET, now)).toBe(false);
    expect(verifyStripeSignature(body, null, SECRET, now)).toBe(false);
    expect(verifyStripeSignature(body, sign(body, t), "", now)).toBe(false);
  });
});

describe("reading a subscription", () => {
  const sub = (keys: string[], extra: Partial<StripeSubscription> = {}): StripeSubscription => ({
    id: "sub_1", customer: "cus_1", status: "active", cancel_at_period_end: false, metadata: {},
    items: { data: keys.map((k, i) => ({ id: `si_${i}`, current_period_end: 1_790_000_000, price: { id: `price_${i}`, lookup_key: k } })) },
    ...extra,
  });

  it("finds the plan from the main price, not the extra-user price", () => {
    expect(planOf(sub(["cedro_corporate_extra_user_year", "cedro_corporate_year"]))).toEqual({ plan: "cedro_corporate", interval: "year" });
    expect(planOf(sub(["dealer_month"]))).toEqual({ plan: "dealer", interval: "month" });
    expect(planOf(sub(["something_else"]))).toBeNull();
  });

  it("reads the period end from the subscription or, on newer Stripe versions, from its items", () => {
    expect(periodEnd(sub(["dealer_month"]))?.getTime()).toBe(1_790_000_000_000);
    expect(periodEnd(sub(["dealer_month"], { current_period_end: 1_795_000_000 }))?.getTime()).toBe(1_795_000_000_000);
  });
});
