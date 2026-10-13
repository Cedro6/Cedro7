import { zoneOf } from "../platform/locale";
import { withTenant } from "@bos/db/runtime";
import type { Ctx } from "../platform/context";
import { StateError, ValidationError } from "../platform/errors";
import { requirePermission } from "../platform/permissions";

/**
 * Money going out. One list holds supplier bills and everyday expenses: a bill is simply an
 * expense that has a due date and has not been paid yet. Each one is paid in full, once.
 *
 * "Stock purchases" is what was paid for goods to resell. It is money out, but it is not counted
 * again as a running cost when working out profit, because the cost of goods sold already covers it.
 */
export const EXPENSE_CATEGORIES = [
  "Stock purchases", "Rent", "Payroll", "Utilities", "Shipping and delivery", "Marketing", "Software",
  "Bank and card fees", "Insurance", "Vehicles and travel", "Repairs and equipment", "Professional fees", "Taxes and licences", "Other",
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];
export const STOCK_CATEGORY: ExpenseCategory = "Stock purchases";
export const isExpenseCategory = (v: unknown): v is ExpenseCategory => (EXPENSE_CATEGORIES as readonly unknown[]).includes(v);

export type Expense = {
  id: string;
  supplierId: string | null;
  supplierName: string | null;
  purchaseOrderId: string | null;
  purchaseOrderNumber: string | null;
  category: ExpenseCategory;
  description: string;
  reference: string | null;
  amount: number;
  /** Dates are YYYY-MM-DD. */
  incurredOn: string;
  dueOn: string | null;
  paidOn: string | null;
  paidMethod: string | null;
  voided: boolean;
  voidReason: string | null;
  /** Days past the due date today. Zero when paid, voided, not due yet or with no due date. */
  daysLate: number;
};

export type ExpenseInput = {
  description: string;
  category: string;
  amount: number;
  incurredOn: string;
  dueOn?: string;
  supplierId?: string;
  purchaseOrderId?: string;
  reference?: string;
  /** Set when it has already been paid, such as a card purchase. */
  paidOn?: string;
  paidMethod?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

const select = (ctx: Ctx) => `
  select e.id, e.supplier_id as "supplierId", s.name as "supplierName", e.purchase_order_id as "purchaseOrderId", po.number as "purchaseOrderNumber",
         e.category, e.description, e.reference, e.amount::float8 as amount,
         to_char(e.incurred_on, 'YYYY-MM-DD') as "incurredOn", to_char(e.due_on, 'YYYY-MM-DD') as "dueOn", to_char(e.paid_on, 'YYYY-MM-DD') as "paidOn",
         e.paid_method as "paidMethod", e.voided_at is not null as voided, e.void_reason as "voidReason",
         case when e.paid_on is null and e.voided_at is null and e.due_on is not null
              then greatest(((now() at time zone '${zoneOf(ctx)}')::date - e.due_on), 0) else 0 end::int as "daysLate"
    from expenses e left join suppliers s on s.id = e.supplier_id left join purchase_orders po on po.id = e.purchase_order_id`;

function clean(input: ExpenseInput) {
  const description = input.description.trim();
  const optional = (v: string | undefined) => v?.trim() || null;
  if (!description) throw new ValidationError("description", "Say what this was for.");
  if (description.length > 200) throw new ValidationError("description", "Keep the description under 200 characters.");
  if (!isExpenseCategory(input.category)) throw new ValidationError("category", "Choose a category.");
  if (!Number.isFinite(input.amount) || input.amount <= 0) throw new ValidationError("amount", "Enter an amount above zero.");
  if (input.amount > 1e9) throw new ValidationError("amount", "That amount is too large.");
  if (Math.round(input.amount * 100) !== Math.round(input.amount * 1e6) / 1e4) throw new ValidationError("amount", "Enter the amount in dollars and cents.");
  if (!isDate(input.incurredOn)) throw new ValidationError("incurredOn", "Enter the date of the bill or purchase.");
  const dueOn = optional(input.dueOn);
  const paidOn = optional(input.paidOn);
  if (dueOn && !isDate(dueOn)) throw new ValidationError("dueOn", "Enter a valid due date.");
  if (dueOn && dueOn < input.incurredOn) throw new ValidationError("dueOn", "The due date cannot be before the bill date.");
  if (paidOn && !isDate(paidOn)) throw new ValidationError("paidOn", "Enter a valid payment date.");
  const supplierId = optional(input.supplierId);
  const purchaseOrderId = optional(input.purchaseOrderId);
  if ((supplierId && !UUID.test(supplierId)) || (purchaseOrderId && !UUID.test(purchaseOrderId))) throw new ValidationError("supplierId", "Supplier not found.");
  return {
    description, category: input.category, amount: Math.round(input.amount * 100) / 100, incurredOn: input.incurredOn, dueOn, paidOn,
    supplierId, purchaseOrderId, reference: optional(input.reference)?.slice(0, 60) ?? null, paidMethod: paidOn ? (optional(input.paidMethod)?.slice(0, 40) ?? null) : null,
  };
}

async function audit(tx: { query: (sql: string, params: unknown[]) => Promise<unknown> }, ctx: Ctx, action: string, id: string, after: unknown) {
  await tx.query(
    `insert into audit_log (org_id, actor_type, actor_id, action, entity_type, entity_id, after) values ($1, 'user', $2, $3, 'expense', $4, $5)`,
    [ctx.orgId, ctx.userId, action, id, JSON.stringify(after)],
  );
}

export async function createExpense(ctx: Ctx, input: ExpenseInput): Promise<{ id: string }> {
  requirePermission(ctx, "expense.write");
  const e = clean(input);
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    let supplierId = e.supplierId;
    if (e.purchaseOrderId) {
      const po = await tx.query<{ supplier_id: string }>("select supplier_id from purchase_orders where id = $1", [e.purchaseOrderId]);
      if (!po.rows[0]) throw new ValidationError("purchaseOrderId", "Purchase order not found.");
      if (supplierId && supplierId !== po.rows[0].supplier_id) throw new ValidationError("purchaseOrderId", "That purchase order is with a different supplier.");
      supplierId = po.rows[0].supplier_id;
    }
    if (supplierId && (await tx.query("select 1 from suppliers where id = $1", [supplierId])).rowCount === 0) throw new ValidationError("supplierId", "Supplier not found.");
    const created = await tx.query<{ id: string }>(
      `insert into expenses (org_id, supplier_id, purchase_order_id, category, description, reference, amount, incurred_on, due_on, paid_on, paid_method, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
      [ctx.orgId, supplierId, e.purchaseOrderId, e.category, e.description, e.reference, e.amount, e.incurredOn, e.dueOn, e.paidOn, e.paidMethod, ctx.userId],
    );
    const id = created.rows[0]!.id;
    await audit(tx, ctx, "expense.created", id, { description: e.description, category: e.category, amount: e.amount, paid: Boolean(e.paidOn) });
    return { id };
  });
}

/** Marks a bill as paid in full. A bill is paid once; paying it again is refused. */
export async function payExpense(ctx: Ctx, id: string, input: { paidOn: string; method?: string }): Promise<void> {
  requirePermission(ctx, "expense.write");
  if (!UUID.test(id)) throw new ValidationError("id", "Bill not found.");
  if (!isDate(input.paidOn)) throw new ValidationError("paidOn", "Enter the date it was paid.");
  const method = input.method?.trim().slice(0, 40) || null;
  await withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const row = await tx.query<{ paid: boolean; voided: boolean }>("select paid_on is not null as paid, voided_at is not null as voided from expenses where id = $1 for update", [id]);
    if (!row.rows[0]) throw new ValidationError("id", "Bill not found.");
    if (row.rows[0].voided) throw new StateError("This bill was voided, so it cannot be paid.");
    if (row.rows[0].paid) throw new StateError("This bill is already marked as paid.");
    await tx.query("update expenses set paid_on = $2, paid_method = $3 where id = $1", [id, input.paidOn, method]);
    await audit(tx, ctx, "expense.paid", id, { paidOn: input.paidOn, method });
  });
}

/** Cancels a bill or expense entered by mistake. The record stays, and stops counting everywhere. */
export async function voidExpense(ctx: Ctx, id: string, reason: string): Promise<void> {
  requirePermission(ctx, "expense.write");
  if (!UUID.test(id)) throw new ValidationError("id", "Bill not found.");
  const why = reason.trim();
  if (!why) throw new ValidationError("reason", "Say why this is being voided.");
  if (why.length > 200) throw new ValidationError("reason", "Keep the reason under 200 characters.");
  await withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const row = await tx.query<{ voided: boolean }>("select voided_at is not null as voided from expenses where id = $1 for update", [id]);
    if (!row.rows[0]) throw new ValidationError("id", "Bill not found.");
    if (row.rows[0].voided) throw new StateError("This was already voided.");
    await tx.query("update expenses set voided_at = now(), void_reason = $2, paid_on = null, paid_method = null where id = $1", [id, why]);
    await audit(tx, ctx, "expense.voided", id, { reason: why });
  });
}

export const EXPENSE_FILTERS = ["unpaid", "paid", "all", "voided"] as const;
export type ExpenseFilter = (typeof EXPENSE_FILTERS)[number];

export async function listExpenses(ctx: Ctx, filter: ExpenseFilter = "unpaid"): Promise<Expense[]> {
  requirePermission(ctx, "expense.read");
  const where = {
    unpaid: "e.voided_at is null and e.paid_on is null",
    paid: "e.voided_at is null and e.paid_on is not null",
    all: "e.voided_at is null",
    voided: "e.voided_at is not null",
  }[filter];
  const order = filter === "unpaid" ? "e.due_on nulls last, e.incurred_on" : "e.incurred_on desc, e.created_at desc";
  return withTenant(ctx.pool, ctx.orgId, async (tx) => (await tx.query<Expense>(`${select(ctx)} where ${where} order by ${order} limit 500`)).rows);
}

export async function getExpense(ctx: Ctx, id: string): Promise<Expense | null> {
  requirePermission(ctx, "expense.read");
  if (!UUID.test(id)) return null;
  return withTenant(ctx.pool, ctx.orgId, async (tx) => (await tx.query<Expense>(`${select(ctx)} where e.id = $1`, [id])).rows[0] ?? null);
}

export type ExpenseSummary = {
  /** Unpaid bills today. */
  owed: number;
  unpaid: number;
  overdue: number;
  overdueCount: number;
  /** Due in the next 7 days, today included. */
  dueSoon: number;
  /** Paid so far this calendar month. */
  paidThisMonth: number;
};

export async function expenseSummary(ctx: Ctx): Promise<ExpenseSummary> {
  requirePermission(ctx, "expense.read");
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const r = await tx.query<ExpenseSummary>(
      `with t as (select (now() at time zone '${zoneOf(ctx)}')::date as today)
       select coalesce(sum(amount) filter (where paid_on is null), 0)::float8 as owed,
              count(*) filter (where paid_on is null)::int as unpaid,
              coalesce(sum(amount) filter (where paid_on is null and due_on < t.today), 0)::float8 as overdue,
              count(*) filter (where paid_on is null and due_on < t.today)::int as "overdueCount",
              coalesce(sum(amount) filter (where paid_on is null and due_on between t.today and t.today + 6), 0)::float8 as "dueSoon",
              coalesce(sum(amount) filter (where paid_on >= date_trunc('month', t.today)), 0)::float8 as "paidThisMonth"
         from expenses, t where voided_at is null`,
    );
    return r.rows[0]!;
  });
}
