import { currencyOf, moneyText } from "../platform/locale";
import { randomUUID } from "node:crypto";
import { withTenant } from "@bos/db/runtime";
import { createInvoice } from "../billing/invoices";
import { createExpense, EXPENSE_CATEGORIES, isExpenseCategory } from "../billing/expenses";
import { customerPricesInTx } from "../sales/pricing";
import { createReturn, listReturnable } from "../sales/returns";
import { getProduct } from "../catalog/products";
import { createCustomer, getCustomer, saveContact, updateCustomer } from "../crm/customers";
import { createReminder, listReminders, listTeam, clock, setReminderDone } from "../crm/reminders";
import type { Ctx } from "../platform/context";
import { StateError, ValidationError } from "../platform/errors";
import { featureOn } from "../platform/features";
import { can } from "../platform/permissions";
import { getSupplier } from "../purchasing/orders";
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
const qtyText = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 4 });
const bad = (message: string) => new ValidationError("assistant", message);

type Line = { productId: string; qty: number };
function readLines(value: unknown): Line[] {
  if (!Array.isArray(value) || value.length === 0) throw bad("Say which products and how many.");
  if (value.length > 50) throw bad("That is too many lines for one request. Split it up.");
  return value.map((raw) => {
    const row = (raw ?? {}) as Record<string, unknown>;
    const qty = Number(row.qty);
    // A discount or a special price is a financial decision, which Ava does not make.
    if (row.discount_percent !== undefined || row.unit_price !== undefined || row.price !== undefined) {
      throw bad("I only use the customer's normal prices. A discount or a special price is your decision: create the quote, then set it on the order yourself.");
    }
    if (!Number.isFinite(qty) || qty <= 0) throw bad("Each quantity must be more than zero.");
    return { productId: str(row.product_id, 36), qty };
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

/**
 * What Ava may prepare. She works like a secretary: she does the paperwork and never makes a
 * financial decision. So there is deliberately nothing here that takes or records a payment, pays a
 * bill, refunds or credits a customer, raises a purchase order, voids an invoice, or sets a price,
 * cost, discount or tax. Those are done by a person on their own screens.
 */
export const ASSISTANT_ACTIONS: AssistantAction[] = [
  {
    name: "propose_quote",
    description:
      "Prepare a new sales quote for a customer, for the person to confirm. Prices always come from the customer's price list: you cannot set a price or a discount. Look up the customer and product ids first.",
    input_schema: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
        lines: lineSchema,
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
        parts.push(`${qtyText(line.qty)} × ${product.name}`);
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
      return { message: `Quote ${made.number} created${order ? ` for ${moneyText(order.total, currencyOf(ctx))}` : ""}.`, link: `/sales/${made.id}` };
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
        summary: `Confirm quote ${order.number} for ${order.customerName} (${moneyText(order.total, currencyOf(ctx))})${featureOn(ctx.features, "stock") ? " and reserve the stock for it" : ""}.`,
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
          : `Complete ${order.number} for ${order.customerName} (${moneyText(order.total, currencyOf(ctx))}) and raise the invoice.`,
      };
    },
    apply: async (ctx, payload) => {
      const id = String(payload.orderId);
      const done = await shipOrder(ctx, id, { idempotencyKey: String(payload.key) });
      const billed = done.invoice ? ` Invoice ${done.invoice.number} raised for ${moneyText(done.invoice.amount, currencyOf(ctx))}.` : "";
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
      return { payload: { orderId: order.id }, summary: `Cancel ${order.status === "quote" ? "quote" : "order"} ${order.number} for ${order.customerName} (${moneyText(order.total, currencyOf(ctx))}). This cannot be undone.` };
    },
    apply: async (ctx, payload) => {
      const id = String(payload.orderId);
      const { released } = await cancelOrder(ctx, id);
      return { message: `Order cancelled.${released > 0 ? ` ${qtyText(released)} units returned to stock.` : ""}`, link: `/sales/${id}` };
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
    description: "Prepare a reminder on the calendar for a date (YYYY-MM-DD), optionally at a time of day, about a customer and for a named team member (ids from list_reminders), for the person to confirm. Work out the date from today's date.",
    input_schema: {
      type: "object",
      properties: { title: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD" }, time: { type: "string", description: "Optional time of day, 24-hour HH:MM" }, customer_id: { type: "string" }, for_user_id: { type: "string" } },
      required: ["title", "date"],
    },
    allowed: (ctx) => featureOn(ctx.features, "calendar"),
    describe: async (ctx, input) => {
      const title = str(input.title);
      const dueOn = str(input.date, 10);
      if (!title) throw bad("Say what the reminder is for.");
      const dueTime = str(input.time, 5);
      if (dueTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(dueTime)) throw bad("I need the time as hours and minutes, such as 14:30.");
      const when = new Date(`${dueOn}T12:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dueOn) || Number.isNaN(when.getTime()) || when.toISOString().slice(0, 10) !== dueOn) throw bad("I need a real date for the reminder.");
      const customer = input.customer_id && can(ctx, "customer.read") ? await getCustomer(ctx, str(input.customer_id, 36)) : null;
      if (input.customer_id && !customer) throw bad("I could not find that customer.");
      const team = await listTeam(ctx);
      const person = input.for_user_id ? team.find((m) => m.id === str(input.for_user_id, 36)) : team.find((m) => m.id === ctx.userId);
      if (!person) throw bad("I could not find that person on the team.");
      const date = when.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
      return {
        payload: { title, dueOn, ...(dueTime ? { dueTime } : {}), ...(customer ? { customerId: customer.id } : {}), assignedTo: person.id },
        summary: `Add a reminder for ${person.id === ctx.userId ? "you" : person.name} on ${date}${dueTime ? ` at ${clock(dueTime)}` : ""}: "${title}"${customer ? `, about ${customer.name}` : ""}.`,
      };
    },
    apply: async (ctx, payload) => {
      await createReminder(ctx, payload as Parameters<typeof createReminder>[1]);
      return { message: "Reminder added.", link: `/calendar?month=${String(payload.dueOn).slice(0, 7)}&day=${String(payload.dueOn)}` };
    },
  },
  {
    name: "propose_invoice",
    description:
      "Prepare a hand-written invoice for a customer, for the person to confirm. Use it for goods or services sold without an order; a shipped order is invoiced by itself. Prices always come from the customer's price list: you cannot set a price, discount or tax. Look up the customer and product ids first.",
    input_schema: {
      type: "object",
      properties: { customer_id: { type: "string" }, lines: lineSchema, notes: { type: "string" } },
      required: ["customer_id", "lines"],
    },
    allowed: (ctx) => can(ctx, "invoice.write") && can(ctx, "customer.read") && can(ctx, "product.read"),
    describe: async (ctx, input) => {
      const customer = await getCustomer(ctx, str(input.customer_id, 36));
      if (!customer) throw bad("I could not find that customer.");
      const lines = readLines(input.lines);
      const ids = [...new Set(lines.map((l) => l.productId))];
      const prices = await withTenant(ctx.pool, ctx.orgId, (tx) => customerPricesInTx(tx, customer.id, ids));
      const parts: string[] = [];
      const priced: { description: string; qty: number; unitPrice: number; productId: string }[] = [];
      let total = 0;
      for (const line of lines) {
        const product = await getProduct(ctx, line.productId);
        const unitPrice = prices.get(line.productId);
        if (!product || unitPrice === undefined) throw bad("I could not find one of those products.");
        priced.push({ description: product.name, qty: line.qty, unitPrice, productId: product.id });
        total += line.qty * unitPrice;
        parts.push(`${qtyText(line.qty)} × ${product.name} at ${moneyText(unitPrice, currencyOf(ctx))}`);
      }
      const notes = str(input.notes, 500);
      return {
        payload: { customerId: customer.id, lines: priced, ...(notes ? { notes } : {}) },
        summary: `Invoice ${customer.name} for ${parts.join(", ")}: ${moneyText(Math.round(total * 100) / 100, currencyOf(ctx))} before tax, on their usual terms.${notes ? ` Note: "${notes}"` : ""}`,
      };
    },
    apply: async (ctx, payload) => {
      const made = await createInvoice(ctx, payload as Parameters<typeof createInvoice>[1]);
      return { message: `Invoice ${made.number} raised for ${moneyText(made.amount, currencyOf(ctx))}. Nothing has been sent or charged.`, link: `/invoices/${made.id}` };
    },
  },
  {
    name: "propose_return",
    description:
      "Prepare to take goods back on a shipped order, for the person to confirm. Say which products and how many, and why. The goods go back into stock when restock is true. No credit or refund is given: that is the person's decision afterwards. Needs the order id from list_orders.",
    input_schema: {
      type: "object",
      properties: {
        order_id: { type: "string" },
        lines: lineSchema,
        reason: { type: "string" },
        restock: { type: "boolean", description: "True when the goods are fit to sell again. Default true." },
      },
      required: ["order_id", "lines", "reason"],
    },
    allowed: (ctx) => featureOn(ctx.features, "returns") && can(ctx, "sales_order.write"),
    describe: async (ctx, input) => {
      const order = await getOrder(ctx, str(input.order_id, 36));
      if (!order) throw bad("I could not find that order.");
      const reason = str(input.reason, 200);
      if (!reason) throw bad("Say why the goods came back.");
      const returnable = await listReturnable(ctx, order.id);
      const lines = readLines(input.lines);
      const parts: string[] = [];
      const picked: { orderLineId: string; qty: number }[] = [];
      for (const line of lines) {
        const match = returnable.find((r) => r.productId === line.productId);
        if (!match) throw bad(`${order.number} has no shipped line for one of those products.`);
        if (line.qty > match.left) throw bad(`Only ${qtyText(match.left)} of ${match.name} can still come back on ${order.number}.`);
        picked.push({ orderLineId: match.orderLineId, qty: line.qty });
        parts.push(`${qtyText(line.qty)} × ${match.name}`);
      }
      const restock = input.restock !== false;
      return {
        payload: { orderId: order.id, lines: picked, reason, restock, idempotencyKey: randomUUID() },
        summary: `Take back ${parts.join(", ")} on ${order.number} from ${order.customerName} because "${reason}"${restock ? ", and put the goods back into stock" : ", not fit to restock"}. No credit or refund: you decide that afterwards.`,
      };
    },
    apply: async (ctx, payload) => {
      const { orderId, ...rest } = payload as { orderId: string } & Parameters<typeof createReturn>[2];
      const made = await createReturn(ctx, orderId, { ...rest, credit: false });
      return { message: `Return ${made.number} recorded: ${qtyText(made.units)} units worth ${moneyText(made.value, currencyOf(ctx))}${made.restocked ? ", back in stock" : ""}. No credit has been given.`, link: `/sales/${orderId}` };
    },
  },
  {
    name: "propose_bill",
    description:
      "Prepare to file a supplier's bill or a running cost, for the person to confirm. Filing records that it is owed; it is never paid here. Give the amount, what it is for, the date and a category. Look up the supplier id with find_suppliers when it is from a supplier.",
    input_schema: {
      type: "object",
      properties: {
        description: { type: "string" },
        amount: { type: "number", description: "The total on the bill, tax included." },
        category: { type: "string", enum: [...EXPENSE_CATEGORIES] },
        incurred_on: { type: "string", description: "The bill's date, YYYY-MM-DD." },
        due_on: { type: "string", description: "Optional, YYYY-MM-DD." },
        supplier_id: { type: "string" },
        reference: { type: "string", description: "The supplier's invoice number, if any." },
      },
      required: ["description", "amount", "category", "incurred_on"],
    },
    allowed: (ctx) => featureOn(ctx.features, "expenses") && can(ctx, "expense.write"),
    describe: async (ctx, input) => {
      const description = str(input.description, 200);
      const amount = Number(input.amount);
      const category = input.category;
      const incurredOn = str(input.incurred_on, 10);
      const dueOn = str(input.due_on, 10);
      const reference = str(input.reference, 100);
      if (!description) throw bad("Say what the bill is for.");
      if (!Number.isFinite(amount) || amount <= 0) throw bad("The amount must be more than zero.");
      if (!isExpenseCategory(category)) throw bad(`Pick one of these categories: ${EXPENSE_CATEGORIES.join(", ")}.`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(incurredOn)) throw bad("I need the bill's date as YYYY-MM-DD.");
      if (dueOn && !/^\d{4}-\d{2}-\d{2}$/.test(dueOn)) throw bad("I need the due date as YYYY-MM-DD.");
      const supplierId = str(input.supplier_id, 36);
      const supplier = supplierId ? await getSupplier(ctx, supplierId) : null;
      if (supplierId && !supplier) throw bad("I could not find that supplier.");
      return {
        payload: { description, amount, category, incurredOn, ...(dueOn ? { dueOn } : {}), ...(supplier ? { supplierId: supplier.id } : {}), ...(reference ? { reference } : {}) },
        summary: `File a bill${supplier ? ` from ${supplier.name}` : ""} for ${moneyText(amount, currencyOf(ctx))}: "${description}" under ${category}, dated ${incurredOn}${dueOn ? `, due ${dueOn}` : ""}${reference ? `, ref ${reference}` : ""}. It is filed as owed, not paid.`,
      };
    },
    apply: async (ctx, payload) => {
      const made = await createExpense(ctx, payload as Parameters<typeof createExpense>[1]);
      return { message: "Bill filed as owed. Paying it is done on the Bills screen.", link: `/bills/${made.id}` };
    },
  },
  {
    name: "propose_reminder_done",
    description: "Prepare to mark a reminder as done, for the person to confirm. Needs the reminder id from list_reminders.",
    input_schema: { type: "object", properties: { reminder_id: { type: "string" } }, required: ["reminder_id"] },
    allowed: (ctx) => featureOn(ctx.features, "calendar"),
    describe: async (ctx, input) => {
      const id = str(input.reminder_id, 36);
      const reminder = (await listReminders(ctx, { openOnly: true })).find((r) => r.id === id);
      if (!reminder) throw bad("I could not find an open reminder with that id.");
      return { payload: { reminderId: reminder.id }, summary: `Mark the reminder "${reminder.title}"${reminder.customerName ? ` (${reminder.customerName})` : ""} as done.` };
    },
    apply: async (ctx, payload) => {
      await setReminderDone(ctx, String(payload.reminderId), true);
      return { message: "Reminder marked done.", link: "/calendar" };
    },
  },
  {
    name: "propose_customer_update",
    description:
      "Prepare a change to a customer's details (name, payment terms, billing or shipping address), for the person to confirm. Give only the fields that change. Needs the customer id from find_customers. Tax status and prices are not changed here.",
    input_schema: {
      type: "object",
      properties: { customer_id: { type: "string" }, name: { type: "string" }, payment_terms: { type: "string" }, billing_address: { type: "string" }, shipping_address: { type: "string" } },
      required: ["customer_id"],
    },
    allowed: (ctx) => can(ctx, "customer.write"),
    describe: async (ctx, input) => {
      const customer = await getCustomer(ctx, str(input.customer_id, 36));
      if (!customer) throw bad("I could not find that customer.");
      const changes: string[] = [];
      const next = {
        name: input.name !== undefined ? str(input.name) : customer.name,
        paymentTerms: input.payment_terms !== undefined ? str(input.payment_terms, 50) : customer.paymentTerms ?? undefined,
        billingAddress: input.billing_address !== undefined ? str(input.billing_address, 500) : customer.billingAddress ?? undefined,
        shippingAddress: input.shipping_address !== undefined ? str(input.shipping_address, 500) : customer.shippingAddress ?? undefined,
        taxExempt: customer.taxExempt,
      };
      if (input.name !== undefined && next.name !== customer.name) changes.push(`name to "${next.name}"`);
      if (input.payment_terms !== undefined && next.paymentTerms !== (customer.paymentTerms ?? "")) changes.push(`payment terms to "${next.paymentTerms || "none"}"`);
      if (input.billing_address !== undefined && next.billingAddress !== (customer.billingAddress ?? "")) changes.push(`billing address to "${next.billingAddress || "none"}"`);
      if (input.shipping_address !== undefined && next.shippingAddress !== (customer.shippingAddress ?? "")) changes.push(`shipping address to "${next.shippingAddress || "none"}"`);
      if (!next.name) throw bad("The customer needs a name.");
      if (changes.length === 0) throw bad("Nothing would change. Say what should be different.");
      return { payload: { customerId: customer.id, ...next }, summary: `Change ${customer.name}: ${changes.join("; ")}.` };
    },
    apply: async (ctx, payload) => {
      const { customerId, ...rest } = payload as { customerId: string } & Parameters<typeof updateCustomer>[2];
      await updateCustomer(ctx, customerId, rest);
      return { message: "Customer updated.", link: `/customers/${customerId}` };
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
