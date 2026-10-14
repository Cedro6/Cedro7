import { createHmac, timingSafeEqual } from "node:crypto";
import { lookupKey, PLANS, yearlyPrice, type Interval, type PlanId } from "@bos/core";

/**
 * The few Stripe calls billing needs, made directly over HTTPS. STRIPE_SECRET_KEY turns billing on;
 * STRIPE_API_BASE only exists so tests can point at a stand-in.
 */
export const stripeConfigured = (): boolean => Boolean(process.env.STRIPE_SECRET_KEY);
const base = () => process.env.STRIPE_API_BASE || "https://api.stripe.com";

export class StripeError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "StripeError";
  }
}

/** Stripe takes form fields with nested names, like line_items[0][price]. */
function form(params: Record<string, unknown>, prefix = "", out = new URLSearchParams()): URLSearchParams {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) value.forEach((v, i) => (typeof v === "object" ? form(v as Record<string, unknown>, `${name}[${i}]`, out) : out.append(`${name}[]`, String(v))));
    else if (typeof value === "object") form(value as Record<string, unknown>, name, out);
    else out.append(name, String(value));
  }
  return out;
}

async function call<T>(method: "GET" | "POST" | "DELETE", path: string, params: Record<string, unknown> = {}, idempotencyKey?: string): Promise<T> {
  const body = form(params);
  const url = method === "GET" ? `${base()}${path}${body.size ? `?${body}` : ""}` : `${base()}${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      "stripe-version": "2025-03-31.basil",
      ...(method === "GET" ? {} : { "content-type": "application/x-www-form-urlencoded" }),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    body: method === "GET" ? undefined : body,
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await response.json().catch(() => ({}))) as { error?: { message?: string } } & T;
  if (!response.ok) throw new StripeError(json.error?.message ?? `Stripe answered ${response.status}`, response.status);
  return json;
}

type Price = { id: string; product: string; lookup_key: string | null };
const priceCache = new Map<string, string>();

/**
 * The Stripe price for a plan, found by its lookup key, or made the first time it is needed. Nothing
 * has to be set up by hand in Stripe: the products and prices appear on the first checkout.
 */
export async function priceFor(plan: PlanId, interval: Interval, extra = false): Promise<string> {
  const key = lookupKey(plan, interval, extra);
  const cached = priceCache.get(key);
  if (cached) return cached;
  const found = await call<{ data: Price[] }>("GET", "/v1/prices", { lookup_keys: [key], active: true, limit: 1 });
  let id = found.data[0]?.id;
  if (!id) {
    const p = PLANS[plan];
    const monthlyAmount = extra ? p.extraUser! : p.monthly;
    const amount = interval === "year" ? (extra ? monthlyAmount * 10 : yearlyPrice(p)) : monthlyAmount;
    const name = extra ? `${p.name}: extra user` : p.product === "dealer" ? "Dealer Terminal" : `Cedro Terminal ${p.name}`;
    const product = await call<{ id: string }>("POST", "/v1/products", { name, metadata: { plan, extra: extra ? "yes" : "no" } }, `product-${key}`);
    const made = await call<Price>("POST", "/v1/prices", {
      product: product.id, currency: "usd", unit_amount: amount * 100, recurring: { interval }, lookup_key: key, transfer_lookup_key: true, metadata: { plan, extra: extra ? "yes" : "no" },
    }, `price-${key}-${amount}`);
    id = made.id;
  }
  priceCache.set(key, id);
  return id;
}

export type StripeSubscription = {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end: boolean;
  current_period_end?: number;
  metadata: Record<string, string>;
  items: { data: { id: string; quantity?: number; current_period_end?: number; price: { id: string; lookup_key: string | null; recurring?: { interval: string } } }[] };
};

/** Starts Stripe Checkout for a plan. Any trial days left carry over, so subscribing early costs nothing extra. */
export async function createCheckout(input: {
  orgId: string; plan: PlanId; interval: Interval; extraUsers: number; customerId: string | null; email: string; trialEndsAt: Date | null; origin: string;
}): Promise<string> {
  const items: Record<string, unknown>[] = [{ price: await priceFor(input.plan, input.interval), quantity: 1 }];
  if (input.extraUsers > 0 && PLANS[input.plan].extraUser !== null) items.push({ price: await priceFor(input.plan, input.interval, true), quantity: input.extraUsers });
  // Stripe needs a trial to end at least two days ahead; a shorter remainder is simply not carried over.
  const trialEnd = input.trialEndsAt && input.trialEndsAt.getTime() > Date.now() + 2 * 86_400_000 + 3_600_000 ? Math.floor(input.trialEndsAt.getTime() / 1000) : undefined;
  const session = await call<{ url: string }>("POST", "/v1/checkout/sessions", {
    mode: "subscription",
    line_items: items,
    ...(input.customerId ? { customer: input.customerId } : { customer_email: input.email }),
    client_reference_id: input.orgId,
    subscription_data: { metadata: { org_id: input.orgId, plan: input.plan }, ...(trialEnd ? { trial_end: trialEnd } : {}) },
    metadata: { org_id: input.orgId, plan: input.plan },
    allow_promotion_codes: true,
    billing_address_collection: "auto",
    success_url: `${input.origin}/settings/billing?checkout={CHECKOUT_SESSION_ID}`,
    cancel_url: `${input.origin}/settings/billing?cancelled=1`,
  });
  return session.url;
}

export async function getCheckout(sessionId: string): Promise<{ client_reference_id: string | null; customer: string | null; subscription: StripeSubscription | null }> {
  return call("GET", `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, { expand: ["subscription"] });
}

export async function getSubscription(id: string): Promise<StripeSubscription> {
  return call("GET", `/v1/subscriptions/${encodeURIComponent(id)}`);
}

/**
 * Moves a subscription to another plan or billing period, and sets how many extra users it pays for.
 * Stripe works out the difference for the part of the period already paid.
 */
export async function changeSubscription(sub: StripeSubscription, plan: PlanId, interval: Interval, extraUsers: number): Promise<StripeSubscription> {
  const extraKey = (key: string | null) => Boolean(key && key.includes("_extra_user_"));
  const main = sub.items.data.find((i) => !extraKey(i.price.lookup_key));
  const extra = sub.items.data.find((i) => extraKey(i.price.lookup_key));
  const items: Record<string, unknown>[] = [];
  items.push(main ? { id: main.id, price: await priceFor(plan, interval), quantity: 1 } : { price: await priceFor(plan, interval), quantity: 1 });
  const wantsExtra = PLANS[plan].extraUser !== null && extraUsers > 0;
  if (extra && !wantsExtra) items.push({ id: extra.id, deleted: true });
  else if (wantsExtra) items.push(extra ? { id: extra.id, price: await priceFor(plan, interval, true), quantity: extraUsers } : { price: await priceFor(plan, interval, true), quantity: extraUsers });
  return call("POST", `/v1/subscriptions/${encodeURIComponent(sub.id)}`, { items, proration_behavior: "create_prorations", metadata: { ...sub.metadata, plan }, cancel_at_period_end: false });
}

/** Stripe's own page for the card, past invoices and cancelling. */
export async function portalUrl(customerId: string, returnUrl: string): Promise<string> {
  return (await call<{ url: string }>("POST", "/v1/billing_portal/sessions", { customer: customerId, return_url: returnUrl })).url;
}

/** The plan and period a subscription is on, read from its main price's lookup key. */
export function planOf(sub: StripeSubscription): { plan: PlanId; interval: Interval } | null {
  for (const item of sub.items.data) {
    const key = item.price.lookup_key ?? "";
    if (key.includes("_extra_user_")) continue;
    const m = key.match(/^(cedro_basic|cedro_small|cedro_corporate|dealer)_(month|year)$/);
    if (m) return { plan: m[1] as PlanId, interval: m[2] as Interval };
  }
  return null;
}

/** When the paid period ends. Newer Stripe versions keep it on each item rather than the subscription. */
export const periodEnd = (sub: StripeSubscription): Date | null => {
  const t = sub.current_period_end ?? sub.items.data[0]?.current_period_end;
  return t ? new Date(t * 1000) : null;
};

/**
 * Checks a notification really came from Stripe: the signature is an HMAC of the timestamp and the
 * exact body with the endpoint's secret, and the timestamp must be within five minutes.
 */
export function verifyStripeSignature(rawBody: string, header: string | null, secret: string, now = Date.now()): boolean {
  if (!header || !secret) return false;
  const parts = header.split(",").map((p) => p.split("=") as [string, string]);
  const t = parts.find(([k]) => k === "t")?.[1];
  const signatures = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || !/^\d+$/.test(t) || !signatures.length) return false;
  if (Math.abs(now / 1000 - Number(t)) > 300) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex"));
  return signatures.some((s) => {
    const given = Buffer.from(s);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
