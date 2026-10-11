import { randomUUID } from "node:crypto";
import { withTenant } from "@bos/db/runtime";
import { getInvoice, PAYMENT_METHODS, recordPayment } from "../billing/invoices";
import { getProduct } from "../catalog/products";
import { createCustomer, getCustomer, saveContact } from "../crm/customers";
import { createReminder, listTeam } from "../crm/reminders";
import type { Ctx } from "../platform/context";
import { StateError, ValidationError } from "../platform/errors";
import { featureOn } from "../platform/features";
import { can } from "../platform/permissions";
import { createPurchaseOrder, getSupplier } from "../purchasing/orders";
import { adjustStock, StockInputError, InsufficientStockError } from "../inventory/ledger";
import { cancelOrder, confirmOrder, createQuote, getOrder, shipOrder } from "../sales/orders";

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
  {
    name: "propose_ship_order",
    description:
      "Prepare to ship an open order (everything currently reserved for it goes out as one shipment and the invoice is raised), for the person to confirm. If stock is not tracked this completes the order. Needs the order id from list_orders.",
    input_schema: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] },
    allowed: (ctx) => can(ctx, "sales_order.ship") && can(ctx, "sales_order.read"),
    describe: async (ctx, input) => {
      const order = await getOrder(ctx, str(input.order_id, 36));
      if (!order) throw bad("I could not find that order.");
      if (order.status !== "confirmed" && order.status !== "partially_shipped") throw bad(`${order.number} is ${order.status.replace("_", " ")}, so it cannot be shipped.`);
      const tracked = featureOn(ctx.features, "stock");
      const ready = order.lines.reduce((sum, line) => sum + line.reserved, 0);
      const short = order.lines.reduce((sum, line) => sum + line.backorder, 0);
      if (tracked && ready <= 0) throw bad(`${order.number} has no stock reserved yet, so there is nothing to ship.`);
      return {
        payload: { orderId: order.id, key: randomUUID() },
        summary: tracked
          ? `Ship ${qtyText(ready)} units on ${order.number} for ${order.customerName} and raise the invoice.${short > 0 ? ` ${qtyText(short)} units have no stock yet and stay on the order.` : ""}`
          : `Complete ${order.number} for ${order.customerName} (${money(order.total)}) and raise the invoice.`,
      };
    },
    apply: async (ctx, payload) => {
      const id = String(payload.orderId);
      const done = await shipOrder(ctx, id, { idempotencyKey: String(payload.key) });
      const billed = done.invoice ? ` Invoice ${done.invoice.number} raised for ${money(done.invoice.amount)}.` : "";
      return { message: featureOn(ctx.features, "stock") ? `${done.shipmentNumber} shipped with ${qtyText(done.units)} units.${billed}` : `Order completed.${billed}`, link: `/sales/${id}` };
    },
  },
  {
    name: "propose_cancel_order",
    description: "Prepare to cancel a quote or an order that has not shipped (reserved stock goes back on the shelf), for the person to confirm. Needs the order id from list_orders.",
    input_schema: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] },
    allowed: (ctx) => can(ctx, "sales_order.write"),
    describe: async (ctx, input) => {
      const order = await getOrder(ctx, str(input.order_id, 36));
      if (!order) throw bad("I could not find that order.");
      if (order.status !== "quote" && order.status !== "confirmed") throw bad(`${order.number} is ${order.status.replace("_", " ")}, so it cannot be cancelled.`);
      return { payload: { orderId: order.id }, summary: `Cancel ${order.status === "quote" ? "quote" : "order"} ${order.number} for ${order.customerName} (${money(order.total)}). This cannot be undone.` };
    },
    apply: async (ctx, payload) => {
      const id = String(payload.orderId);
      const { released } = await cancelOrder(ctx, id);
      return { message: `Order cancelled.${released > 0 ? ` ${qtyText(released)} units returned to stock.` : ""}`, link: `/sales/${id}` };
    },
  },
  {
    name: "propose_payment",
    description: `Prepare to record a payment received against an invoice, for the person to confirm. Leave amount out to record the full balance. Method must be one of: ${PAYMENT_METHODS.join(", ")}. Needs the invoice id from list_invoices.`,
    input_schema: {
      type: "object",
      properties: { invoice_id: { type: "string" }, amount: { type: "number" }, method: { type: "string", enum: [...PAYMENT_METHODS] }, reference: { type: "string" } },
      required: ["invoice_id", "method"],
    },
    allowed: (ctx) => can(ctx, "invoice.write") && can(ctx, "sales_order.read"),
    describe: async (ctx, input) => {
      const invoice = await getInvoice(ctx, str(input.invoice_id, 36));
      if (!invoice) throw bad("I could not find that invoice.");
      if (invoice.balance <= 0) throw bad(`${invoice.number} has nothing left to pay.`);
      const method = str(input.method, 30);
      if (!(PAYMENT_METHODS as readonly string[]).includes(method)) throw bad(`Say how it was paid: ${PAYMENT_METHODS.join(", ")}.`);
      const amount = input.amount === undefined || input.amount === null ? invoice.balance : Math.round(Number(input.amount) * 100) / 100;
      if (!Number.isFinite(amount) || amount <= 0) throw bad("The amount must be more than zero.");
      if (amount > invoice.balance) throw bad(`${invoice.number} only has ${money(invoice.balance)} left to pay.`);
      const reference = str(input.reference, 80);
      return {
        payload: { invoiceId: invoice.id, amount, method, ...(reference ? { reference } : {}), key: randomUUID() },
        summary: `Record a ${money(amount)} payment by ${method.toLowerCase()} from ${invoice.customerName} against ${invoice.number}${reference ? `, reference "${reference}"` : ""}. ${amount >= invoice.balance ? "This pays it in full." : `${money(invoice.balance - amount)} will still be owed.`}`,
      };
    },
    apply: async (ctx, payload) => {
      const id = String(payload.invoiceId);
      const done = await recordPayment(ctx, id, { amount: Number(payload.amount), method: String(payload.method), reference: payload.reference ? String(payload.reference) : undefined, idempotencyKey: String(payload.key) });
      return { message: `Payment recorded. ${done.balance > 0 ? `${money(done.balance)} still owed.` : "The invoice is paid in full."}`, link: `/invoices/${id}` };
    },
  },
  {
    name: "propose_stock_adjustment",
    description: "Prepare a correction to a product's stock on hand (positive to add, negative to remove) with a reason, for the person to confirm. Needs the product id from find_products.",
    input_schema: { type: "object", properties: { product_id: { type: "string" }, change: { type: "number", description: "Units to add (positive) or remove (negative)." }, reason: { type: "string" } }, required: ["product_id", "change", "reason"] },
    allowed: (ctx) => featureOn(ctx.features, "stock") && can(ctx, "stock.adjust") && can(ctx, "product.read"),
    describe: async (ctx, input) => {
      const product = await getProduct(ctx, str(input.product_id, 36));
      if (!product) throw bad("I could not find that product.");
      const change = Number(input.change);
      if (!Number.isFinite(change) || change === 0) throw bad("Say how many units to add or remove.");
      const reason = str(input.reason);
      if (!reason) throw bad("Give a reason for the correction.");
      if (product.onHand + change < product.reserved) throw bad(`Only ${qtyText(product.available)} of ${product.name} can be removed; the rest is reserved for orders.`);
      return {
        payload: { productId: product.id, qtyDelta: change, reason, key: randomUUID() },
        summary: `${change > 0 ? "Add" : "Remove"} ${qtyText(Math.abs(change))} ${change > 0 ? "to" : "from"} the stock of ${product.name}, taking it from ${qtyText(product.onHand)} to ${qtyText(product.onHand + change)} on hand. Reason: "${reason}".`,
      };
    },
    apply: async (ctx, payload) => {
      const id = String(payload.productId);
      try {
        await adjustStock(ctx, { productId: id, qtyDelta: Number(payload.qtyDelta), reason: String(payload.reason), idempotencyKey: String(payload.key) });
      } catch (error) {
        if (error instanceof InsufficientStockError) throw bad("Stock has changed since this was prepared, and that many can no longer be removed. Ask again.");
        if (error instanceof StockInputError) throw bad(error.message);
        throw error;
      }
      const product = await getProduct(ctx, id);
      return { message: `Stock corrected.${product ? ` ${product.name} now has ${qtyText(product.onHand)} on hand.` : ""}`, link: `/products/${id}` };
    },
  },
  {
    name: "propose_reminder",
    description: "Prepare a reminder on the calendar for a date (YYYY-MM-DD), optionally about a customer and for a named team member (ids from list_reminders), for the person to confirm. Work out the date from today's date.",
    input_schema: {
      type: "object",
      properties: { title: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD" }, customer_id: { type: "string" }, for_user_id: { type: "string" } },
      required: ["title", "date"],
    },
    allowed: (ctx) => featureOn(ctx.features, "calendar"),
    describe: async (ctx, input) => {
      const title = str(input.title);
      const dueOn = str(input.date, 10);
      if (!title) throw bad("Say what the reminder is for.");
      const when = new Date(`${dueOn}T12:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dueOn) || Number.isNaN(when.getTime()) || when.toISOString().slice(0, 10) !== dueOn) throw bad("I need a real date for the reminder.");
      const customer = input.customer_id && can(ctx, "customer.read") ? await getCustomer(ctx, str(input.customer_id, 36)) : null;
      if (input.customer_id && !customer) throw bad("I could not find that customer.");
      const team = await listTeam(ctx);
      const person = input.for_user_id ? team.find((m) => m.id === str(input.for_user_id, 36)) : team.find((m) => m.id === ctx.userId);
      if (!person) throw bad("I could not find that person on the team.");
      const date = when.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
      return {
        payload: { title, dueOn, ...(customer ? { customerId: customer.id } : {}), assignedTo: person.id },
        summary: `Add a reminder for ${person.id === ctx.userId ? "you" : person.name} on ${date}: "${title}"${customer ? `, about ${customer.name}` : ""}.`,
      };
    },
    apply: async (ctx, payload) => {
      await createReminder(ctx, payload as Parameters<typeof createReminder>[1]);
      return { message: "Reminder added.", link: `/calendar?month=${String(payload.dueOn).slice(0, 7)}&day=${String(payload.dueOn)}` };
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
