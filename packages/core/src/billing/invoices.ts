import { withTenant, type PoolClient } from "@bos/db/runtime";
import type { Ctx } from "../platform/context";
import { StateError, ValidationError } from "../platform/errors";
import { requirePermission } from "../platform/permissions";

/**
 * Invoices, payments and credit notes.
 *
 * Money here is whole cents. Every function that changes what is owed on an invoice locks the
 * invoice row first, so two payments arriving together cannot both be accepted past the balance.
 * A function that touches a customer's credit also locks the customer row, before any invoice.
 */

export type InvoiceKind = "shipment" | "deposit" | "manual";
export type InvoiceState = "unpaid" | "part_paid" | "paid" | "overdue" | "void";

export type InvoiceSummary = {
  id: string;
  number: string;
  kind: InvoiceKind;
  customerId: string;
  customerName: string;
  orderId: string | null;
  orderNumber: string | null;
  issuedAt: Date;
  dueAt: Date;
  amount: number;
  paid: number;
  credited: number;
  balance: number;
  state: InvoiceState;
};

export type InvoiceLine = {
  description: string;
  sku: string | null;
  qty: number;
  unitPrice: number;
  listPrice: number;
  discountPercent: number;
  amount: number;
};

export type Payment = {
  id: string;
  amount: number;
  method: string;
  reference: string | null;
  paidAt: Date;
  recordedBy: string | null;
};
export type AppliedCredit = { number: string; amount: number; reason: string; appliedAt: Date };

export type InvoiceDetail = InvoiceSummary & {
  /** The addresses as they were when the invoice was issued. */
  billToAddress: string | null;
  shipToAddress: string | null;
  shipmentNumber: string | null;
  depositPercent: number | null;
  taxRate: number;
  subtotal: number;
  tax: number;
  gross: number;
  depositApplied: number;
  paymentTerms: string | null;
  notes: string | null;
  voidedAt: Date | null;
  voidReason: string | null;
  paidAt: Date | null;
  lines: InvoiceLine[];
  payments: Payment[];
  credits: AppliedCredit[];
  /** Credit on the customer's account that could be used against this invoice. */
  customerCredit: number;
};

export type Statement = {
  customerId: string;
  customerName: string;
  invoices: InvoiceSummary[];
  owed: number;
  overdue: number;
  credit: number;
};

export const PAYMENT_METHODS = ["Bank transfer", "Check", "Card", "Cash", "Other"] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cents = (value: number): number => Math.round(value * 100) / 100;
const twoDecimals = (value: number): boolean => Math.abs(Math.round(value * 100) - value * 100) < 1e-6;

/** "Net 30" is 30 days. Terms with no number in them are due on issue. */
export function termsDays(terms: string | null | undefined): number {
  const match = /(\d{1,3})/.exec(terms ?? "");
  return match ? Number(match[1]) : 0;
}

const SUMMARY_SQL = `
  select i.id, i.number, i.kind, i.customer_id as "customerId", c.name as "customerName",
         i.order_id as "orderId", o.number as "orderNumber",
         i.issued_at as "issuedAt", i.due_at as "dueAt", i.amount::float8 as amount,
         m.paid::float8 as paid, m.credited::float8 as credited,
         (case when i.voided_at is not null then 0 else i.amount - m.paid - m.credited end)::float8 as balance,
         case when i.voided_at is not null then 'void'
              when i.amount - m.paid - m.credited <= 0 then 'paid'
              when i.due_at < date_trunc('day', now()) then 'overdue'
              when m.paid + m.credited > 0 then 'part_paid'
              else 'unpaid' end as state,
         i.tax_rate::float8 as "taxRate", i.subtotal::float8 as subtotal, i.tax::float8 as tax,
         i.gross::float8 as gross, i.deposit_applied::float8 as "depositApplied",
         i.deposit_percent::float8 as "depositPercent", i.payment_terms as "paymentTerms", i.notes,
         i.voided_at as "voidedAt", i.void_reason as "voidReason", s.number as "shipmentNumber",
         case when i.voided_at is null and i.amount - m.paid - m.credited <= 0 then m.last_at end as "paidAt"
  from invoices i
  join customers c on c.id = i.customer_id
  left join sales_orders o on o.id = i.order_id
  left join shipments s on s.id = i.shipment_id
  join lateral (
    select coalesce((select sum(p.amount) from payments p where p.invoice_id = i.id), 0) as paid,
           coalesce((select sum(a.amount) from credit_applications a where a.invoice_id = i.id), 0) as credited,
           greatest((select max(p.paid_at) from payments p where p.invoice_id = i.id),
                    (select max(a.applied_at) from credit_applications a where a.invoice_id = i.id), i.issued_at) as last_at
  ) m on true`;

async function nextNumber(tx: PoolClient, orgId: string, docType: string, prefix: string): Promise<string> {
  const result = await tx.query<{ n: number }>(
    `insert into document_counters (org_id, doc_type, last_number) values ($1, $2, 1)
     on conflict (org_id, doc_type) do update set last_number = document_counters.last_number + 1
     returning last_number as n`,
    [orgId, docType],
  );
  return `${prefix}-${String(result.rows[0]!.n).padStart(6, "0")}`;
}

async function audit(tx: PoolClient, ctx: Ctx, action: string, type: string, id: string, after: unknown): Promise<void> {
  await tx.query(
    `insert into audit_log (org_id, actor_type, actor_id, action, entity_type, entity_id, after)
     values ($1, 'user', $2, $3, $4, $5, $6)`,
    [ctx.orgId, ctx.userId, action, type, id, JSON.stringify(after)],
  );
}

type LockedInvoice = {
  customerId: string;
  kind: InvoiceKind;
  number: string;
  amount: number;
  voided: boolean;
  paid: number;
  credited: number;
  balance: number;
};

/** Locks one invoice and returns what is still owed on it. Null when it is not this company's. */
async function lockInvoice(tx: PoolClient, invoiceId: string): Promise<LockedInvoice | null> {
  if (!UUID.test(invoiceId)) return null;
  const locked = await tx.query<{ customer_id: string; kind: InvoiceKind; number: string; amount: number; voided: boolean }>(
    `select customer_id, kind, number, amount::float8 as amount, voided_at is not null as voided
     from invoices where id = $1 for update`,
    [invoiceId],
  );
  const row = locked.rows[0];
  if (!row) return null;
  const sums = await tx.query<{ paid: number; credited: number }>(
    `select coalesce((select sum(amount) from payments where invoice_id = $1), 0)::float8 as paid,
            coalesce((select sum(amount) from credit_applications where invoice_id = $1), 0)::float8 as credited`,
    [invoiceId],
  );
  const { paid, credited } = sums.rows[0]!;
  return {
    customerId: row.customer_id,
    kind: row.kind,
    number: row.number,
    amount: row.amount,
    voided: row.voided,
    paid,
    credited,
    balance: row.voided ? 0 : cents(row.amount - paid - credited),
  };
}

/**
 * Raises the invoice for a shipment (or a completed order) inside the transaction that posted it.
 * Called by the order engine, which has already checked the person may ship; the order row is locked.
 * A deposit already billed on the order comes off the following invoices until it is used up.
 */
export async function invoiceShipmentInTx(
  tx: PoolClient,
  ctx: Ctx,
  input: { orderId: string; shipmentId: string; lines: { orderLineId: string; qty: number }[] },
): Promise<{ id: string; number: string; amount: number }> {
  const order = await tx.query<{ customer_id: string; tax_rate: number; payment_terms: string | null }>(
    `select o.customer_id, o.tax_rate::float8 as tax_rate, c.payment_terms
     from sales_orders o join customers c on c.id = o.customer_id where o.id = $1`,
    [input.orderId],
  );
  const header = order.rows[0];
  if (!header) throw new StateError("Order not found.");
  const source = await tx.query<{
    id: string;
    product_id: string;
    name: string;
    unit_price: number;
    list_price: number;
    discount_pct: number;
  }>(
    `select l.id, l.product_id, p.name, l.unit_price::float8 as unit_price, l.list_price::float8 as list_price,
            l.discount_pct::float8 as discount_pct
     from sales_order_lines l join products p on p.id = l.product_id
     where l.order_id = $1 order by l.position`,
    [input.orderId],
  );
  const byId = new Map(source.rows.map((row) => [row.id, row]));
  const lines = input.lines.map((line) => {
    const row = byId.get(line.orderLineId);
    if (!row) throw new StateError("A shipped line is not on this order.");
    return { ...row, qty: line.qty, amount: cents(line.qty * row.unit_price) };
  });
  const subtotal = cents(lines.reduce((sum, line) => sum + line.amount, 0));
  const tax = cents(subtotal * header.tax_rate);
  const gross = cents(subtotal + tax);
  const deposit = await tx.query<{ left: number }>(
    `select (coalesce((select sum(amount) from invoices where order_id = $1 and kind = 'deposit' and voided_at is null), 0)
           - coalesce((select sum(deposit_applied) from invoices where order_id = $1 and voided_at is null), 0))::float8 as left`,
    [input.orderId],
  );
  const depositApplied = Math.max(0, Math.min(cents(deposit.rows[0]!.left), gross));
  const amount = cents(gross - depositApplied);
  const number = await nextNumber(tx, ctx.orgId, "invoice", "INV");
  const created = await tx.query<{ id: string }>(
    `insert into invoices (org_id, number, kind, customer_id, order_id, shipment_id, tax_rate, subtotal, tax, gross,
                           deposit_applied, amount, payment_terms, due_at, created_by)
     values ($1, $2, 'shipment', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now() + make_interval(days => $13), $14)
     returning id`,
    [
      ctx.orgId,
      number,
      header.customer_id,
      input.orderId,
      input.shipmentId,
      header.tax_rate,
      subtotal,
      tax,
      gross,
      depositApplied,
      amount,
      header.payment_terms,
      termsDays(header.payment_terms),
      ctx.userId,
    ],
  );
  const id = created.rows[0]!.id;
  for (const [index, line] of lines.entries()) {
    await tx.query(
      `insert into invoice_lines (org_id, invoice_id, position, product_id, description, qty, unit_price, list_price, discount_pct, amount)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        ctx.orgId,
        id,
        index + 1,
        line.product_id,
        line.name,
        line.qty,
        line.unit_price,
        line.list_price,
        line.discount_pct,
        line.amount,
      ],
    );
  }
  await audit(tx, ctx, "invoice.raised", "invoice", id, { number, amount, depositApplied, orderId: input.orderId });
  return { id, number, amount };
}

/** Bills part of an order up front. Allowed once per order, before anything has shipped. */
export async function requestDeposit(
  ctx: Ctx,
  orderId: string,
  percent: number,
): Promise<{ id: string; number: string; amount: number }> {
  requirePermission(ctx, "invoice.write");
  if (!UUID.test(orderId)) throw new StateError("Order not found.");
  if (!Number.isFinite(percent) || percent <= 0 || percent >= 100 || !twoDecimals(percent)) {
    throw new ValidationError("percent", "Enter a deposit between 1 and 99 percent.");
  }
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const order = await tx.query<{ status: string; customer_id: string; tax_rate: number; subtotal: number }>(
      `select o.status, o.customer_id, o.tax_rate::float8 as tax_rate,
              coalesce((select sum(round(l.qty * l.unit_price, 2)) from sales_order_lines l where l.order_id = o.id), 0)::float8 as subtotal
       from sales_orders o where o.id = $1 for update of o`,
      [orderId],
    );
    const row = order.rows[0];
    if (!row) throw new StateError("Order not found.");
    if (row.status !== "quote" && row.status !== "confirmed") {
      throw new StateError("A deposit can only be requested before anything has shipped.");
    }
    const existing = await tx.query(
      "select 1 from invoices where order_id = $1 and kind = 'deposit' and voided_at is null",
      [orderId],
    );
    if (existing.rowCount) throw new StateError("This order already has a deposit invoice.");
    const total = cents(row.subtotal + cents(row.subtotal * row.tax_rate));
    const amount = cents((total * percent) / 100);
    if (amount <= 0) throw new StateError("The order total is zero, so there is nothing to bill.");
    const number = await nextNumber(tx, ctx.orgId, "invoice", "INV");
    const created = await tx.query<{ id: string }>(
      `insert into invoices (org_id, number, kind, customer_id, order_id, deposit_percent, tax_rate, subtotal, tax, gross, amount, due_at, created_by)
       values ($1, $2, 'deposit', $3, $4, $5, 0, $6, 0, $6, $6, now(), $7) returning id`,
      [ctx.orgId, number, row.customer_id, orderId, percent, amount, ctx.userId],
    );
    const id = created.rows[0]!.id;
    await tx.query(
      `insert into invoice_lines (org_id, invoice_id, position, description, qty, unit_price, list_price, amount)
       values ($1, $2, 1, $3, 1, $4, $4, $4)`,
      [ctx.orgId, id, `Deposit of ${percent}% on the order`, amount],
    );
    await audit(tx, ctx, "invoice.deposit_requested", "invoice", id, { number, amount, percent, orderId });
    return { id, number, amount };
  });
}

/** An invoice written by hand, not tied to an order. */
export async function createInvoice(
  ctx: Ctx,
  input: {
    customerId: string;
    lines: { description: string; qty: number; unitPrice: number; productId?: string }[];
    taxRatePercent?: number;
    dueInDays?: number;
    notes?: string;
  },
): Promise<{ id: string; number: string; amount: number }> {
  requirePermission(ctx, "invoice.write");
  if (!UUID.test(input.customerId)) throw new ValidationError("customerId", "Choose a customer.");
  if (input.lines.length === 0) throw new ValidationError("lines", "Add at least one line.");
  if (input.lines.length > 200) throw new ValidationError("lines", "An invoice can have at most 200 lines.");
  for (const line of input.lines) {
    if (!line.description.trim()) throw new ValidationError("lines", "Describe every line.");
    if (line.description.length > 300) throw new ValidationError("lines", "Keep each description under 300 characters.");
    if (!Number.isFinite(line.qty) || line.qty <= 0 || line.qty > 1e9) {
      throw new ValidationError("lines", "Each quantity must be greater than zero.");
    }
    if (!Number.isFinite(line.unitPrice) || line.unitPrice < 0 || line.unitPrice > 1e12) {
      throw new ValidationError("lines", "A price cannot be negative.");
    }
    if (line.productId !== undefined && !UUID.test(line.productId)) {
      throw new ValidationError("lines", "Choose a product from the list.");
    }
  }
  // Left out, the tax is the company's usual rate, or nothing for a customer marked as not charged tax.
  const givenTax = input.taxRatePercent;
  if (givenTax !== undefined && (!Number.isFinite(givenTax) || givenTax < 0 || givenTax >= 100)) {
    throw new ValidationError("taxRatePercent", "Tax must be between 0 and 100 percent.");
  }
  if (input.dueInDays !== undefined && (!Number.isInteger(input.dueInDays) || input.dueInDays < 0 || input.dueInDays > 365)) {
    throw new ValidationError("dueInDays", "Days until due must be a whole number from 0 to 365.");
  }
  const notes = input.notes?.trim() || null;
  if (notes && notes.length > 2000) throw new ValidationError("notes", "Keep notes under 2,000 characters.");
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const customer = await tx.query<{ payment_terms: string | null }>(
      "select payment_terms from customers where id = $1 and status = 'active'",
      [input.customerId],
    );
    if (!customer.rows[0]) throw new ValidationError("customerId", "Choose a customer.");
    const terms = customer.rows[0].payment_terms;
    const taxPercent = givenTax ?? (await tx.query<{ tax: number }>(
        "select case when c.tax_exempt then 0 else o.default_tax_percent end::float8 as tax from customers c, organizations o where c.id = $1 and o.id = $2",
        [input.customerId, ctx.orgId],
      )).rows[0]?.tax ?? 0;
    const lines = input.lines.map((line) => ({ ...line, amount: cents(line.qty * line.unitPrice) }));
    const subtotal = cents(lines.reduce((sum, line) => sum + line.amount, 0));
    const tax = cents((subtotal * taxPercent) / 100);
    const gross = cents(subtotal + tax);
    const number = await nextNumber(tx, ctx.orgId, "invoice", "INV");
    const created = await tx.query<{ id: string }>(
      `insert into invoices (org_id, number, kind, customer_id, tax_rate, subtotal, tax, gross, amount, payment_terms, notes, due_at, created_by)
       values ($1, $2, 'manual', $3, $4, $5, $6, $7, $7, $8, $9, now() + make_interval(days => $10), $11) returning id`,
      [
        ctx.orgId,
        number,
        input.customerId,
        taxPercent / 100,
        subtotal,
        tax,
        gross,
        terms,
        notes,
        input.dueInDays ?? termsDays(terms),
        ctx.userId,
      ],
    );
    const id = created.rows[0]!.id;
    for (const [index, line] of lines.entries()) {
      await tx.query(
        `insert into invoice_lines (org_id, invoice_id, position, product_id, description, qty, unit_price, list_price, amount)
         values ($1, $2, $3, $4, $5, $6, $7, $7, $8)`,
        [ctx.orgId, id, index + 1, line.productId ?? null, line.description.trim(), line.qty, line.unitPrice, line.amount],
      );
    }
    await audit(tx, ctx, "invoice.created", "invoice", id, { number, amount: gross });
    return { id, number, amount: gross };
  });
}

/** Records money received. A payment can be part of the balance but never more than it. */
export async function recordPayment(
  ctx: Ctx,
  invoiceId: string,
  input: { amount: number; method: string; reference?: string; idempotencyKey: string },
): Promise<{ balance: number; replayed: boolean }> {
  requirePermission(ctx, "invoice.write");
  if (!input.idempotencyKey.trim()) throw new ValidationError("idempotencyKey", "A request id is required.");
  if (!Number.isFinite(input.amount) || input.amount <= 0 || !twoDecimals(input.amount)) {
    throw new ValidationError("amount", "Enter the amount received, in dollars and cents.");
  }
  if (!(PAYMENT_METHODS as readonly string[]).includes(input.method)) {
    throw new ValidationError("method", "Choose how the payment was made.");
  }
  const reference = input.reference?.trim() || null;
  if (reference && reference.length > 80) throw new ValidationError("reference", "Keep the reference under 80 characters.");
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const invoice = await lockInvoice(tx, invoiceId);
    if (!invoice) throw new StateError("Invoice not found.");
    const earlier = await tx.query("select 1 from payments where idempotency_key = $1", [input.idempotencyKey]);
    if (earlier.rowCount) return { balance: invoice.balance, replayed: true };
    if (invoice.voided) throw new StateError("That invoice has been voided.");
    if (invoice.balance <= 0) throw new StateError("That invoice is already paid.");
    const amount = cents(input.amount);
    if (amount > invoice.balance) {
      throw new ValidationError("amount", `Only $${invoice.balance.toFixed(2)} is still owed on this invoice.`);
    }
    const created = await tx.query<{ id: string }>(
      `insert into payments (org_id, invoice_id, amount, method, reference, idempotency_key, recorded_by)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [ctx.orgId, invoiceId, amount, input.method, reference, input.idempotencyKey, ctx.userId],
    );
    const balance = cents(invoice.balance - amount);
    await audit(tx, ctx, "invoice.payment_recorded", "invoice", invoiceId, {
      paymentId: created.rows[0]!.id,
      amount,
      method: input.method,
      balance,
    });
    return { balance, replayed: false };
  });
}

/** Credit on a customer's account: what their credit notes are worth, less what has been used on invoices or paid back. */
async function creditLeftInTx(tx: PoolClient, customerId: string): Promise<{ id: string; left: number }[]> {
  const notes = await tx.query<{ id: string; left: number }>(
    `select n.id, (n.amount - coalesce((select sum(a.amount) from credit_applications a where a.credit_note_id = n.id), 0)
                            - coalesce((select sum(f.amount) from credit_refunds f where f.credit_note_id = n.id), 0))::float8 as left
     from credit_notes n where n.customer_id = $1 order by n.created_at, n.number`,
    [customerId],
  );
  return notes.rows.filter((row) => row.left > 0);
}

async function applyCreditInTx(
  tx: PoolClient,
  ctx: Ctx,
  invoiceId: string,
  customerId: string,
  balance: number,
  onlyNote?: string,
): Promise<number> {
  let remaining = balance;
  let used = 0;
  for (const note of await creditLeftInTx(tx, customerId)) {
    if (remaining <= 0) break;
    if (onlyNote && note.id !== onlyNote) continue;
    const take = cents(Math.min(note.left, remaining));
    await tx.query(
      "insert into credit_applications (org_id, credit_note_id, invoice_id, amount, applied_by) values ($1, $2, $3, $4, $5)",
      [ctx.orgId, note.id, invoiceId, take, ctx.userId],
    );
    remaining = cents(remaining - take);
    used = cents(used + take);
  }
  return used;
}

/**
 * Raises a credit note for a customer. Given an invoice, the credit is used against it first;
 * anything beyond that invoice's balance stays on the customer's account for later.
 */
/** The same as raiseCredit, inside a transaction the caller already has open. */
export async function raiseCreditInTx(
  tx: PoolClient,
  ctx: Ctx,
  input: { customerId?: string; invoiceId?: string; amount: number; reason: string },
): Promise<{ id: string; number: string; applied: number; onAccount: number }> {
  requirePermission(ctx, "invoice.write");
  if (!Number.isFinite(input.amount) || input.amount <= 0 || !twoDecimals(input.amount) || input.amount > 1e12) {
    throw new ValidationError("amount", "Enter the amount to credit, in dollars and cents.");
  }
  const reason = input.reason.trim();
  if (!reason) throw new ValidationError("reason", "Give a reason for the credit.");
  if (reason.length > 200) throw new ValidationError("reason", "Keep the reason under 200 characters.");
  if (!input.invoiceId && !(input.customerId && UUID.test(input.customerId))) {
    throw new ValidationError("customerId", "Choose a customer.");
  }
  let customerId = input.customerId ?? "";
  if (input.invoiceId) {
    const owner = UUID.test(input.invoiceId)
      ? await tx.query<{ customer_id: string }>("select customer_id from invoices where id = $1", [input.invoiceId])
      : { rows: [] };
    if (!owner.rows[0]) throw new StateError("Invoice not found.");
    customerId = owner.rows[0].customer_id;
  }
  const customer = await tx.query("select 1 from customers where id = $1 for update", [customerId]);
  if (!customer.rowCount) throw new ValidationError("customerId", "Choose a customer.");
  const invoice = input.invoiceId ? await lockInvoice(tx, input.invoiceId) : null;
  if (invoice?.voided) throw new StateError("That invoice has been voided.");
  const amount = cents(input.amount);
  const number = await nextNumber(tx, ctx.orgId, "credit_note", "CN");
  const created = await tx.query<{ id: string }>(
    "insert into credit_notes (org_id, number, customer_id, amount, reason, created_by) values ($1, $2, $3, $4, $5, $6) returning id",
    [ctx.orgId, number, customerId, amount, reason, ctx.userId],
  );
  const id = created.rows[0]!.id;
  const applied =
    invoice && invoice.balance > 0 ? await applyCreditInTx(tx, ctx, input.invoiceId!, customerId, invoice.balance, id) : 0;
  await audit(tx, ctx, "credit_note.raised", "credit_note", id, {
    number,
    amount,
    applied,
    invoiceId: input.invoiceId ?? null,
  });
  return { id, number, applied, onAccount: cents(amount - applied) };
}

export async function raiseCredit(
  ctx: Ctx,
  input: { customerId?: string; invoiceId?: string; amount: number; reason: string },
): Promise<{ id: string; number: string; applied: number; onAccount: number }> {
  requirePermission(ctx, "invoice.write");
  return withTenant(ctx.pool, ctx.orgId, (tx) => raiseCreditInTx(tx, ctx, input));
}

/** Uses credit already on the customer's account against one of their invoices, oldest credit first. */
export async function useCustomerCredit(ctx: Ctx, invoiceId: string): Promise<{ applied: number; balance: number }> {
  requirePermission(ctx, "invoice.write");
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const owner = UUID.test(invoiceId)
      ? await tx.query<{ customer_id: string }>("select customer_id from invoices where id = $1", [invoiceId])
      : { rows: [] };
    if (!owner.rows[0]) throw new StateError("Invoice not found.");
    await tx.query("select 1 from customers where id = $1 for update", [owner.rows[0].customer_id]);
    const invoice = (await lockInvoice(tx, invoiceId))!;
    if (invoice.voided) throw new StateError("That invoice has been voided.");
    if (invoice.balance <= 0) throw new StateError("That invoice is already paid.");
    const applied = await applyCreditInTx(tx, ctx, invoiceId, invoice.customerId, invoice.balance);
    if (applied <= 0) throw new StateError("This customer has no credit to use.");
    const balance = cents(invoice.balance - applied);
    await audit(tx, ctx, "invoice.credit_used", "invoice", invoiceId, { applied, balance });
    return { applied, balance };
  });
}

/** Cancels an invoice written by hand that nothing has been received against. Anything else is corrected with a credit. */
export async function voidInvoice(ctx: Ctx, invoiceId: string, reason: string): Promise<void> {
  requirePermission(ctx, "invoice.write");
  const why = reason.trim();
  if (!why) throw new ValidationError("reason", "Give a reason for voiding the invoice.");
  if (why.length > 200) throw new ValidationError("reason", "Keep the reason under 200 characters.");
  await withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const invoice = await lockInvoice(tx, invoiceId);
    if (!invoice) throw new StateError("Invoice not found.");
    if (invoice.voided) throw new StateError("That invoice is already void.");
    if (invoice.kind !== "manual") {
      throw new StateError("Only an invoice written by hand can be voided. For an order's invoice, raise a credit instead.");
    }
    if (invoice.paid > 0 || invoice.credited > 0) {
      throw new StateError("Money has been received on this invoice, so it cannot be voided. Raise a credit instead.");
    }
    await tx.query("update invoices set voided_at = now(), void_reason = $2 where id = $1", [invoiceId, why]);
    await audit(tx, ctx, "invoice.voided", "invoice", invoiceId, { reason: why });
  });
}

export async function listInvoices(
  ctx: Ctx,
  options: { state?: InvoiceState | "open"; customerId?: string; orderId?: string } = {},
): Promise<InvoiceSummary[]> {
  requirePermission(ctx, "sales_order.read");
  if (options.customerId && !UUID.test(options.customerId)) return [];
  if (options.orderId && !UUID.test(options.orderId)) return [];
  const states = options.state === "open" ? ["unpaid", "part_paid", "overdue"] : options.state ? [options.state] : null;
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const result = await tx.query<InvoiceSummary>(
      `select * from (${SUMMARY_SQL}) v
       where ($1::text[] is null or v.state = any($1)) and ($2::uuid is null or v."customerId" = $2)
         and ($3::uuid is null or v."orderId" = $3)
       order by v."issuedAt" desc, v.number desc limit 500`,
      [states, options.customerId ?? null, options.orderId ?? null],
    );
    return result.rows;
  });
}

export async function getInvoice(ctx: Ctx, invoiceId: string): Promise<InvoiceDetail | null> {
  requirePermission(ctx, "sales_order.read");
  if (!UUID.test(invoiceId)) return null;
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const header = await tx.query<Omit<InvoiceDetail, "lines" | "payments" | "credits" | "customerCredit" | "billToAddress" | "shipToAddress">>(
      `${SUMMARY_SQL} where i.id = $1`,
      [invoiceId],
    );
    const found = header.rows[0];
    if (!found) return null;
    const frozen = await tx.query<{ billToAddress: string | null; shipToAddress: string | null }>(
      `select bill_to_address as "billToAddress", ship_to_address as "shipToAddress" from invoices where id = $1`,
      [invoiceId],
    );
    const invoice = { ...found, ...frozen.rows[0]! };
    const lines = await tx.query<InvoiceLine>(
      `select l.description, p.sku, l.qty::float8 as qty, l.unit_price::float8 as "unitPrice",
              l.list_price::float8 as "listPrice", l.discount_pct::float8 as "discountPercent", l.amount::float8 as amount
       from invoice_lines l left join products p on p.id = l.product_id
       where l.invoice_id = $1 order by l.position`,
      [invoiceId],
    );
    const payments = await tx.query<Payment>(
      `select p.id, p.amount::float8 as amount, p.method, p.reference, p.paid_at as "paidAt", u.name as "recordedBy"
       from payments p left join users u on u.id = p.recorded_by where p.invoice_id = $1 order by p.paid_at`,
      [invoiceId],
    );
    const credits = await tx.query<AppliedCredit>(
      `select n.number, a.amount::float8 as amount, n.reason, a.applied_at as "appliedAt"
       from credit_applications a join credit_notes n on n.id = a.credit_note_id
       where a.invoice_id = $1 order by a.applied_at`,
      [invoiceId],
    );
    const credit = (await creditLeftInTx(tx, invoice.customerId)).reduce((sum, note) => cents(sum + note.left), 0);
    return { ...invoice, lines: lines.rows, payments: payments.rows, credits: credits.rows, customerCredit: credit };
  });
}

export type Refund = { amount: number; method: string; reference: string | null; paidAt: Date; paidBy: string | null };

/**
 * Pays money back to a customer out of the credit on their account, oldest credit first.
 * It can never be more than the credit they have. This records the refund; the money itself is
 * sent however the business pays people.
 */
export async function refundCredit(
  ctx: Ctx,
  customerId: string,
  input: { amount: number; method: string; reference?: string; idempotencyKey: string },
): Promise<{ refunded: number; creditLeft: number; replayed: boolean }> {
  requirePermission(ctx, "invoice.write");
  if (!UUID.test(customerId)) throw new ValidationError("customerId", "Customer not found.");
  if (!Number.isFinite(input.amount) || input.amount <= 0 || !twoDecimals(input.amount)) throw new ValidationError("amount", "Enter the amount to refund, in dollars and cents.");
  const method = input.method.trim();
  if (!method) throw new ValidationError("method", "Say how it was paid back.");
  if (method.length > 40) throw new ValidationError("method", "Keep the method under 40 characters.");
  const reference = input.reference?.trim().slice(0, 100) || null;
  const key = input.idempotencyKey.trim();
  if (!key) throw new ValidationError("idempotencyKey", "The refund could not be identified. Reload the page and try again.");
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const customer = await tx.query("select 1 from customers where id = $1 for update", [customerId]);
    if (!customer.rowCount) throw new ValidationError("customerId", "Customer not found.");
    const total = async () => (await creditLeftInTx(tx, customerId)).reduce((sum, note) => cents(sum + note.left), 0);
    const before = await tx.query<{ amount: number }>("select coalesce(sum(amount), 0)::float8 as amount from credit_refunds where request_key = $1", [key]);
    if (before.rows[0]!.amount > 0) return { refunded: before.rows[0]!.amount, creditLeft: await total(), replayed: true };
    const amount = cents(input.amount);
    const available = await total();
    if (amount > available) {
      throw new ValidationError("amount", available <= 0 ? "This customer has no credit to refund." : `This customer only has ${available.toFixed(2)} in credit.`);
    }
    let remaining = amount;
    for (const note of await creditLeftInTx(tx, customerId)) {
      if (remaining <= 0) break;
      const take = cents(Math.min(note.left, remaining));
      await tx.query(
        "insert into credit_refunds (org_id, credit_note_id, amount, method, reference, request_key, paid_by) values ($1, $2, $3, $4, $5, $6, $7)",
        [ctx.orgId, note.id, take, method, reference, key, ctx.userId],
      );
      remaining = cents(remaining - take);
    }
    await audit(tx, ctx, "customer.refunded", "customer", customerId, { amount, method });
    return { refunded: amount, creditLeft: await total(), replayed: false };
  });
}

/** Refunds paid to a customer, newest first. One line per refund, however many credit notes it drew on. */
export async function listRefunds(ctx: Ctx, customerId: string): Promise<Refund[]> {
  requirePermission(ctx, "sales_order.read");
  if (!UUID.test(customerId)) return [];
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const r = await tx.query<Refund>(
      `select sum(f.amount)::float8 as amount, min(f.method) as method, min(f.reference) as reference, min(f.paid_at) as "paidAt", min(u.name) as "paidBy"
         from credit_refunds f join credit_notes n on n.id = f.credit_note_id left join users u on u.id = f.paid_by
        where n.customer_id = $1 group by f.request_key order by min(f.paid_at) desc`,
      [customerId],
    );
    return r.rows;
  });
}

/** Everything a customer has been billed, what is still owed, and any credit on their account. */
export async function customerStatement(ctx: Ctx, customerId: string): Promise<Statement | null> {
  requirePermission(ctx, "sales_order.read");
  if (!UUID.test(customerId)) return null;
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const customer = await tx.query<{ name: string }>("select name from customers where id = $1", [customerId]);
    if (!customer.rows[0]) return null;
    const invoices = await tx.query<InvoiceSummary>(
      `select * from (${SUMMARY_SQL}) v where v."customerId" = $1 and v.state <> 'void' order by v."issuedAt" desc, v.number desc`,
      [customerId],
    );
    const owed = invoices.rows.reduce((sum, invoice) => cents(sum + invoice.balance), 0);
    const overdue = invoices.rows
      .filter((invoice) => invoice.state === "overdue")
      .reduce((sum, invoice) => cents(sum + invoice.balance), 0);
    const credit = (await creditLeftInTx(tx, customerId)).reduce((sum, note) => cents(sum + note.left), 0);
    return { customerId, customerName: customer.rows[0].name, invoices: invoices.rows, owed, overdue, credit };
  });
}
