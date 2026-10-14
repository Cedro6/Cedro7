import { pool } from "../../../../lib/pool";
import { storeSubscription } from "../../../../lib/billing";
import { getSubscription, verifyStripeSignature, type StripeSubscription } from "../../../../lib/stripe";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Stripe tells us here when a checkout finishes and whenever a subscription changes: renewed,
 * payment failed and retrying, plan changed, cancelled. Only notifications signed with the
 * endpoint's secret are believed. Each one carries the subscription's whole state, so applying the
 * same one twice is harmless, and an older one never overwrites a newer one.
 */
export async function POST(request: Request): Promise<Response> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET ?? "";
  const body = await request.text();
  if (!verifyStripeSignature(body, request.headers.get("stripe-signature"), secret)) return new Response("Bad signature", { status: 400 });
  let event: { type: string; created: number; data: { object: Record<string, unknown> } };
  try {
    event = JSON.parse(body);
  } catch {
    return new Response("Bad body", { status: 400 });
  }
  const at = new Date(event.created * 1000);
  const object = event.data?.object ?? {};
  try {
    if (event.type === "checkout.session.completed") {
      const orgId = String(object.client_reference_id ?? "");
      const subId = typeof object.subscription === "string" ? object.subscription : null;
      if (UUID.test(orgId) && subId) await storeSubscription(pool, orgId, await getSubscription(subId), at);
    } else if (event.type.startsWith("customer.subscription.")) {
      const sub = object as unknown as StripeSubscription;
      const orgId = sub.metadata?.org_id ?? "";
      if (UUID.test(orgId)) await storeSubscription(pool, orgId, event.type === "customer.subscription.deleted" ? { ...sub, status: "canceled" } : sub, at);
    }
  } catch (error) {
    // Stripe tries again later when it does not get a 200, so a passing database hiccup is not lost.
    console.error("billing: webhook could not be applied", event.type, error);
    return new Response("Try again", { status: 500 });
  }
  return Response.json({ received: true });
}
