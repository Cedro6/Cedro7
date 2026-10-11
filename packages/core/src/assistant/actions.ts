import { withTenant } from "@bos/db/runtime";
import { getProduct } from "../catalog/products";
import { createCustomer, getCustomer, saveContact } from "../crm/customers";
import type { Ctx } from "../platform/context";
import { StateError, ValidationError } from "../platform/errors";
import { featureOn } from "../platform/features";
import { can } from "../platform/permissions";
import { createPurchaseOrder, getSupplier } from "../purchasing/orders";
import { confirmOrder, createQuote, getOrder } from "../sales/orders";

/**
 * Changes the assistant can prepare. The model never makes a change: calling one of these only
 * writes a proposal for the person to read. `describe` builds that wording from the company's own
 * records, not from the model's words, so what is confirmed is what will happen. `apply` runs only
 * when the person confirms, through the same functions as the screens, with their permissions.
 */
export type AssistantAction = {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  allowed: (ctx: Ctx) => boolean;
  /** Checks the input against the records and returns the cleaned payload and a plain description. Throws ValidationError if it cannot be done. */
  describe: (ctx: Ctx, input: Record<string, unknown>) => Promise<{ payload: Record<string, unknown>; summary: string }>;
  apply: (ctx: Ctx, payload: Record<string, unknown>) => Promise<{ message: string; link: string }>;
};

const str = (value: unknown, max = 200) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const qtyText = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 4 });
const bad = (message: string) => new ValidationError("assistant", message);

type Line = { productId: string; qty: number; discountPercent?: number };
function readLines(value: unknown): Line[] {
  if (!Array.isArray(value) || value.length === 0) throw bad("Say which products and how many.");
  if (value.length > 50) throw bad("That is too many lines for one request. Split it up.");
  return value.map((raw) => {
    const row = (raw ?? {}) as Record<string, unknown>;
    const qty = Number(row.qty);
    const discount = row.discount_percent === undefined ? 0 : Number(row.discount_percent);
    if (!Number.isFinite(qty) || qty <= 0) throw bad("Each quantity must be more than zero.");
    if (!Number.isFinite(discount) || discount < 0 || discount > 100) throw bad("A discount must be between 0 and 100 percent.");
    return { productId: str(row.product_id, 36), qty, ...(discount > 0 ? { discountPercent: discount } : {}) };
  });
}

const lineSchema = {
  type: "array",
  items: {
    type: "object",
    properties: { product_id: { type: "string", description: "The product's id from find_products." }, qty: { type: "number" } },
    required: ["product_id", "qty"],
  },
};

export const ASSISTANT_ACTIONS: AssistantAction[] = [
  {
    name: "propose_quote",
    description:
      "Prepare a new sales quote for a customer, for the person to confirm. Prices come from the customer's price list. Look up the customer and product ids first.",
    input_schema: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
        lines: { ...lineSchema, items: { ...lineSchema.items, properties: { ...lineSchema.items.properties, discount_percent: { type: "number" } } } },
        notes: { type: "string" },
      },
      required: ["customer_id", "lines"],
    },
    allowed: (ctx) => can(ctx, "sales_order.write") && can(ctx, "customer.read") && can(ctx, "product.read"),
    describe: async (ctx, input) => {
      const customer = await getCustomer(ctx, str(input.customer_id, 36));
      if (!customer) throw bad("I could not find that customer.");
      const lines = readLines(input.lines);
      const parts: string[] = [];
      for (const line of lines) {
        const product = await getProduct(ctx, line.productId);
        if (!product) throw bad("I could not find one of those products.");
        parts.push(`${qtyText(line.qty)} × ${product.name}${line.discountPercent ? ` at ${line.discountPercent}% off` : ""}`);
      }
      const notes = str(input.notes, 500);
      return {
        payload: { customerId: customer.id, lines, ...(notes ? { notes } : {}) },
        summary: `Create a quote for ${customer.name}: ${parts.join(", ")}.${notes ? ` Note: "${notes}"` : ""} Prices come from ${customer.priceListName ? `the "${customer.priceListName}" price list` : "list prices"}.`,
      };
    },
    apply: async (ctx, payload) => {
      const made = await createQuote(ctx, payload as Parameters<typeof createQuote>[1]);
      const order = await getOrder(ctx, made.id);
      return { message: `Quote ${made.number} created${order ? ` for ${money(order.total)}` : ""}.`, link: `/sales/${made.id}` };
    },
  },
  {
    name: "propose_confirm_order",
    description: "Prepare to confirm a quote so it becomes an order (and reserves stock if stock is tracked), for the person to confirm. Needs the order id from list_orders.",
    input_schema: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] },
    allowed: (ctx) => can(ctx, "sales_order.write"),
    describe: async (ctx, input) => {
      const order = await getOrder(ctx, str(input.order_id, 36));
      if (!order) throw bad("I could not find that order.");
      if (order.status !== "quote") throw bad(`${order.number} is not a quote, so there is nothing to confirm.`);
      return {
        payload: { orderId: order.id },
        summary: `Confirm quote ${order.number} for ${order.customerName} (${money(order.total)})${featureOn(ctx.features, "stock") ? " and reserve the stock for it" : ""}.`,
      };
    },
    apply: async (ctx, payload) => {
      const id = String(payload.orderId);
      const { reserved } = await confirmOrder(ctx, id);
      const order = await getOrder(ctx, id);
      return {
        message: `${order?.number ?? "Order"} confirmed.${featureOn(ctx.features, "stock") ? ` ${qtyText(reserved)} units reserved.` : ""}`,
        link: `/sales/${id}`,
      };
    },
  },
  {
    name: "propose_customer",
    description: "Prepare a new customer record, for the person to confirm. Check with find_customers first that they do not already exist.",
    input_schema: { type: "object", properties: { name: { type: "string" }, payment_terms: { type: "string", description: 'For example "Net 30".' } }, required: ["name"] },
    allowed: (ctx) => can(ctx, "customer.write"),
    describe: async (_ctx, input) => {
      const name = str(input.name);
      if (!name) throw bad("Give the customer's name.");
      const paymentTerms = str(input.payment_terms, 50);
      return { payload: { name, ...(paymentTerms ? { paymentTerms } : {}) }, summary: `Add a new customer called ${name}${paymentTerms ? `, on ${paymentTerms} terms` : ""}.` };
    },
    apply: async (ctx, payload) => {
      const made = await createCustomer(ctx, payload as { name: string; paymentTerms?: string });
      return { message: `${String(payload.name)} added as a customer.`, link: `/customers/${made.id}` };
    },
  },
  {
    name: "propose_contact",
    description: "Prepare a new contact person on an existing customer, for the person to confirm.",
    input_schema: {
      type: "object",
      properties: { customer_id: { type: "string" }, name: { type: "string" }, title: { type: "string" }, email: { type: "string" }, phone: { type: "string" }, main_contact: { type: "boolean" } },
      required: ["customer_id", "name"],
    },
    allowed: (ctx) => can(ctx, "customer.write"),
    describe: async (ctx, input) => {
      const customer = await getCustomer(ctx, str(input.customer_id, 36));
      if (!customer) throw bad("I could not find that customer.");
      const contact = { name: str(input.name), title: str(input.title, 100), email: str(input.email), phone: str(input.phone, 50), isPrimary: input.main_contact === true };
      if (!contact.name) throw bad("Give the contact's name.");
      if (contact.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) throw bad("That email address does not look right.");
      const extras = [contact.title, contact.email, contact.phone].filter(Boolean).join(", ");
      return {
        payload: { customerId: customer.id, contact },
        summary: `Add ${contact.name}${extras ? ` (${extras})` : ""} as a contact at ${customer.name}${contact.isPrimary ? ", as the main contact" : ""}.`,
      };
    },
    apply: async (ctx, payload) => {
      const contact = payload.contact as Parameters<typeof saveContact>[2];
      await saveContact(ctx, String(payload.customerId), contact);
      return { message: `${contact.name} added as a contact.`, link: `/customers/${String(payload.customerId)}` };
    },
  },
  {
    name: "propose_purchase_order",
    description:
      "Prepare a draft purchase order with a supplier, for the person to confirm. It is created as a draft and still has to be submitted on the Purchasing screen. Look up the supplier id with find_suppliers and product ids with find_products.",
    input_schema: { type: "object", properties: { supplier_id: { type: "string" }, lines: lineSchema, notes: { type: "string" } }, required: ["supplier_id", "lines"] },
    allowed: (ctx) => featureOn(ctx.features, "purchasing") && can(ctx, "purchase_order.write"),
    describe: async (ctx, input) => {
      const supplier = await getSupplier(ctx, str(input.supplier_id, 36));
      if (!supplier || supplier.status !== "active") throw bad("I could not find that supplier.");
      const lines = readLines(input.lines).map(({ productId, qty }) => ({ productId, qty }));
      const parts: string[] = [];
      for (const line of lines) {
        const product = await getProduct(ctx, line.productId);
        if (!product) throw bad("I could not find one of those products.");
        parts.push(`${qtyText(line.qty)} × ${product.name}`);
      }
      const notes = str(input.notes, 500);
      return {
        payload: { supplierId: supplier.id, lines, ...(notes ? { notes } : {}) },
        summary: `Draft a purchase order with ${supplier.name}: ${parts.join(", ")}. It stays a draft until you submit it.`,
      };
    },
    apply: async (ctx, payload) => {
      const made = await createPurchaseOrder(ctx, payload as Parameters<typeof createPurchaseOrder>[1]);
      return { message: `Draft purchase order ${made.number} created.`, link: `/purchasing/${made.id}` };
    },
  },
];

export const actionsFor = (ctx: Ctx): AssistantAction[] => ASSISTANT_ACTIONS.filter((action) => action.allowed(ctx));

export type Proposal = { id: string; kind: string; summary: string; status: "pending" | "done" | "dismissed"; resultLink: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A proposal goes stale after this long, because the records it was written from may have moved on. */
const FRESH_MINUTES = 60;

/** Records a prepared change for the person to confirm. Nothing is changed yet. */
export async function propose(ctx: Ctx, action: AssistantAction, input: Record<string, unknown>): Promise<Proposal> {
  const { payload, summary } = await action.describe(ctx, input);
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const made = await tx.query<{ id: string }>(
      "insert into assistant_proposals (org_id, user_id, kind, payload, summary) values ($1, $2, $3, $4, $5) returning id",
      [ctx.orgId, ctx.userId, action.name, JSON.stringify(payload), summary],
    );
    return { id: made.rows[0]!.id, kind: action.name, summary, status: "pending", resultLink: null };
  });
}

/**
 * Carries out a proposal the same person was shown. It is claimed first, so pressing Confirm twice
 * does the work once. If the change is refused, the proposal goes back to waiting and the reason is thrown.
 */
export async function confirmProposal(ctx: Ctx, proposalId: string): Promise<{ message: string; link: string }> {
  if (!UUID.test(proposalId)) throw new StateError("That request was not found.");
  const claimed = await withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const result = await tx.query<{ kind: string; payload: Record<string, unknown> }>(
      `update assistant_proposals set status = 'done', decided_at = now()
        where id = $1 and user_id = $2 and status = 'pending' and created_at > now() - make_interval(mins => $3)
        returning kind, payload`,
      [proposalId, ctx.userId, FRESH_MINUTES],
    );
    return result.rows[0];
  });
  if (!claimed) throw new StateError("That request has already been dealt with or has expired. Ask again to get a fresh one.");
  const action = actionsFor(ctx).find((a) => a.name === claimed.kind);
  const release = () =>
    withTenant(ctx.pool, ctx.orgId, (tx) => tx.query("update assistant_proposals set status = 'pending', decided_at = null where id = $1", [proposalId]));
  if (!action) {
    await release();
    throw new StateError("Your role can no longer make that change.");
  }
  try {
    const done = await action.apply(ctx, claimed.payload);
    await withTenant(ctx.pool, ctx.orgId, async (tx) => {
      await tx.query("update assistant_proposals set result_link = $2 where id = $1", [proposalId, done.link]);
      await tx.query(
        `insert into audit_log (org_id, actor_type, actor_id, action, entity_type, entity_id, after)
         values ($1, 'user', $2, 'assistant.confirmed', 'assistant_proposal', $3, $4)`,
        [ctx.orgId, ctx.userId, proposalId, JSON.stringify({ kind: claimed.kind })],
      );
    });
    return done;
  } catch (error) {
    await release();
    throw error;
  }
}

export async function dismissProposal(ctx: Ctx, proposalId: string): Promise<void> {
  if (!UUID.test(proposalId)) return;
  await withTenant(ctx.pool, ctx.orgId, (tx) =>
    tx.query("update assistant_proposals set status = 'dismissed', decided_at = now() where id = $1 and user_id = $2 and status = 'pending'", [proposalId, ctx.userId]),
  );
}
