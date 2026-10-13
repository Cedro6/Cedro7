import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appUrl, createPool, migrate, ownerUrl, seed, type Pool } from "@bos/db";
import {
  analysis, compareRange, confirmOrder, createQuote, ForbiddenError, listCustomers, listInvoices, listProducts, recordPayment, resolveRange, shipOrder, today,
  type Ctx, type Role,
} from "../src/index";

let owner: Pool;
let app: Pool;
let orgId: string;
let userId: string;
const as = (role: Role, features?: Ctx["features"]): Ctx => ({ pool: app, orgId, userId, role, features });

beforeAll(async () => {
  owner = createPool(ownerUrl());
  app = createPool(appUrl());
  await owner.query("drop schema public cascade; create schema public;");
  await migrate(owner);
  ({ orgId, userId } = await seed(owner));
});
afterAll(async () => {
  await app.end();
  await owner.end();
});

describe("report dates", () => {
  it("turns each named period into the right dates", () => {
    const on = "2026-05-20";
    expect(resolveRange("this_month", on)).toEqual({ from: "2026-05-01", to: on });
    expect(resolveRange("last_month", on)).toEqual({ from: "2026-04-01", to: "2026-04-30" });
    expect(resolveRange("this_quarter", on)).toEqual({ from: "2026-04-01", to: on });
    expect(resolveRange("last_quarter", on)).toEqual({ from: "2026-01-01", to: "2026-03-31" });
    expect(resolveRange("last_quarter", "2026-02-10")).toEqual({ from: "2025-10-01", to: "2025-12-31" });
    expect(resolveRange("30d", on)).toEqual({ from: "2026-04-21", to: on });
    expect(resolveRange("ytd", on)).toEqual({ from: "2026-01-01", to: on });
    expect(resolveRange("12m", on)).toEqual({ from: "2025-05-21", to: on });
    expect(resolveRange("last_year", on)).toEqual({ from: "2025-01-01", to: "2025-12-31" });
    expect(resolveRange("custom", on, { from: "2026-02-01", to: "2026-02-14" })).toEqual({ from: "2026-02-01", to: "2026-02-14" });
    // Backwards, impossible or missing custom dates fall back to the last 30 days.
    for (const bad of [{ from: "2026-03-01", to: "2026-02-01" }, { from: "2026-02-31", to: "2026-03-05" }, { from: "x", to: "2026-03-05" }, {}]) {
      expect(resolveRange("custom", on, bad)).toEqual({ from: "2026-04-21", to: on });
    }
  });

  it("compares with the days just before or the same dates a year earlier", () => {
    const range = { from: "2026-03-01", to: "2026-03-31" };
    expect(compareRange(range, "previous")).toEqual({ from: "2026-01-29", to: "2026-02-28" });
    expect(compareRange(range, "year")).toEqual({ from: "2025-03-01", to: "2025-03-31" });
    expect(compareRange({ from: "2024-02-01", to: "2024-02-29" }, "year")).toEqual({ from: "2023-02-01", to: "2023-02-28" });
    expect(compareRange(range, "none")).toBeNull();
  });
});

describe("full report", () => {
  const sell = async (qty: number, unitPrice: number, daysAgo: number, customerIndex = 0) => {
    const product = (await listProducts(as("owner"))).find((p) => p.available >= 20 && (p.cost ?? 0) > 0)!;
    const customer = (await listCustomers(as("owner")))[customerIndex]!;
    const order = await createQuote(as("sales"), { customerId: customer.id, lines: [{ productId: product.id, qty, unitPrice }] });
    await confirmOrder(as("sales"), order.id);
    if (daysAgo > 0) await owner.query("update sales_orders set confirmed_at = now() - make_interval(days => $2) where id = $1", [order.id, daysAgo]);
    return { order, product, customer };
  };
  const last30 = () => resolveRange("30d", today());

  it("sets this period beside the one before, product by product and customer by customer", async () => {
    const before = await analysis(as("owner"), { range: last30() });
    const { product, customer } = await sell(3, 100, 0);
    await sell(1, 80, 40);
    const after = await analysis(as("owner"), { range: last30() });
    expect(after.compare).toEqual(compareRange(last30(), "previous"));
    expect(after.sales.revenue.now - before.sales.revenue.now).toBeCloseTo(300, 2);
    expect(after.sales.revenue.was! - before.sales.revenue.was!).toBeCloseTo(80, 2);
    expect(after.sales.orders.now - before.sales.orders.now).toBe(1);
    expect(after.sales.units.now - before.sales.units.now).toBe(3);
    expect(after.sales.margin!.now - before.sales.margin!.now).toBeCloseTo(300 - 3 * product.cost!, 2);
    const row = after.products.find((p) => p.id === product.id)!;
    const was = before.products.find((p) => p.id === product.id);
    expect(row.revenue.now - (was?.revenue.now ?? 0)).toBeCloseTo(300, 2);
    expect(row.revenue.was! - (was?.revenue.was ?? 0)).toBeCloseTo(80, 2);
    const cust = after.customers.find((c) => c.id === customer.id)!;
    expect(cust.revenue.now).toBeGreaterThanOrEqual(300);
    expect(cust.revenue.was!).toBeGreaterThanOrEqual(80);
    // Every breakdown adds up to the headline figure.
    const sum = (rows: { revenue: { now: number; was: number | null } }[], key: "now" | "was") => rows.reduce((n, r) => n + (r.revenue[key] ?? 0), 0);
    for (const rows of [after.products, after.customers, after.categories, after.people]) {
      expect(sum(rows, "now")).toBeCloseTo(after.sales.revenue.now, 2);
      expect(sum(rows, "was")).toBeCloseTo(after.sales.revenue.was!, 2);
    }
    expect(after.trend.reduce((n, s) => n + s.now, 0)).toBeCloseTo(after.sales.revenue.now, 2);
    expect(after.trend.reduce((n, s) => n + (s.was ?? 0), 0)).toBeCloseTo(after.sales.revenue.was!, 2);
    expect(after.trend).toHaveLength(30);
  });

  it("compares with a year earlier, or with nothing, when asked", async () => {
    const base = await analysis(as("owner"), { range: last30(), mode: "year" });
    await sell(2, 55, 370);
    const year = await analysis(as("owner"), { range: last30(), mode: "year" });
    expect(year.sales.revenue.was! - base.sales.revenue.was!).toBeCloseTo(110, 2);
    expect((await analysis(as("owner"), { range: last30(), mode: "previous" })).sales.revenue.was).toBeCloseTo(
      (await analysis(as("owner"), { range: last30() })).sales.revenue.was!, 2);
    const none = await analysis(as("owner"), { range: last30(), mode: "none" });
    expect(none.compare).toBeNull();
    expect(none.sales.revenue.was).toBeNull();
    expect(none.products.every((p) => p.revenue.was === null)).toBe(true);
    expect(none.trend.every((s) => s.was === null)).toBe(true);
    expect(none.sales.revenue.now).toBeCloseTo(year.sales.revenue.now, 2);
  });

  it("charts a long stretch by week and by month without losing any sales", async () => {
    const quarter = await analysis(as("owner"), { range: resolveRange("90d", today()) });
    expect(quarter.bucket).toBe("week");
    expect(quarter.trend).toHaveLength(13);
    expect(quarter.trend.reduce((n, s) => n + s.now, 0)).toBeCloseTo(quarter.sales.revenue.now, 2);
    const year = await analysis(as("owner"), { range: resolveRange("12m", today()), mode: "year" });
    expect(year.bucket).toBe("month");
    expect(year.trend.reduce((n, s) => n + s.now, 0)).toBeCloseTo(year.sales.revenue.now, 2);
    expect(year.trend.reduce((n, s) => n + (s.was ?? 0), 0)).toBeCloseTo(year.sales.revenue.was!, 2);
  });

  it("counts a customer as new only when their first ever order is in the dates", async () => {
    const customers = await listCustomers(as("owner"));
    const { rows } = await owner.query<{ customer_id: string }>("select distinct customer_id from sales_orders where confirmed_at is not null");
    const index = customers.findIndex((c) => !rows.some((r) => r.customer_id === c.id));
    expect(index).toBeGreaterThanOrEqual(0);
    const before = await analysis(as("owner"), { range: last30() });
    const { customer } = await sell(1, 20, 0, index);
    const after = await analysis(as("owner"), { range: last30() });
    expect(after.sales.newCustomers.now - before.sales.newCustomers.now).toBe(1);
    expect(after.customers.find((c) => c.id === customer.id)!.isNew).toBe(true);
    await sell(1, 20, 200, index);
    const later = await analysis(as("owner"), { range: last30() });
    expect(later.sales.newCustomers.now).toBe(before.sales.newCustomers.now);
    expect(later.customers.find((c) => c.id === customer.id)!.isNew).toBe(false);
  });

  it("reports invoices, payments and who owes money", async () => {
    const before = await analysis(as("owner"), { range: last30() });
    const { order, customer } = await sell(1, 50, 0);
    await shipOrder(as("warehouse"), order.id, { idempotencyKey: randomUUID() });
    const invoice = (await listInvoices(as("owner"), { orderId: order.id }))[0]!;
    await owner.query("update invoices set due_at = now() - interval '10 days' where id = $1", [invoice.id]);
    const owing = await analysis(as("owner"), { range: last30() });
    expect(owing.money.invoiced.now - before.money.invoiced.now).toBeCloseTo(invoice.amount, 2);
    expect(owing.money.owed.late30 - before.money.owed.late30).toBeCloseTo(invoice.amount, 2);
    const debtor = owing.money.debtors.find((d) => d.id === customer.id)!;
    expect(debtor.overdue).toBeGreaterThanOrEqual(invoice.amount);
    expect(debtor.oldest).toBeGreaterThanOrEqual(10);
    expect(owing.money.debtors.reduce((n, d) => n + d.owed, 0)).toBeCloseTo(owing.money.owed.total, 2);
    await recordPayment(as("owner"), invoice.id, { amount: invoice.amount, method: "Check", idempotencyKey: randomUUID() });
    const paid = await analysis(as("owner"), { range: last30() });
    expect(paid.money.collected.now - owing.money.collected.now).toBeCloseTo(invoice.amount, 2);
    expect(owing.money.owed.total - paid.money.owed.total).toBeCloseTo(invoice.amount, 2);
    expect(paid.money.daysToPay.now).not.toBeNull();
  });

  it("lists stock that sold nothing and purchase orders by supplier", async () => {
    const data = await analysis(as("owner"), { range: last30() });
    expect(data.stock!.value).toBeGreaterThan(0);
    const sold = new Set(data.products.filter((p) => p.units.now > 0).map((p) => p.id));
    expect(data.stock!.idle.every((p) => !sold.has(p.id) && p.onHand > 0)).toBe(true);
    expect(data.stock!.idleValue).toBeLessThanOrEqual(data.stock!.value + 0.01);
    expect(data.purchasing).not.toBeNull();
    expect(data.purchasing!.suppliers.reduce((n, s) => n + s.ordered.now, 0)).toBeCloseTo(data.purchasing!.ordered.now, 2);
  });

  it("hides cost, customers and whole sections according to role and features", async () => {
    const sales = await analysis(as("sales"), { range: last30() });
    expect(sales.sales.margin).toBeNull();
    expect(sales.stock).toBeNull();
    expect(sales.products.every((p) => p.margin === null)).toBe(true);
    const lean = await analysis(as("owner", { stock: false, purchasing: false }), { range: last30() });
    expect(lean.stock).toBeNull();
    expect(lean.purchasing).toBeNull();
    await expect(analysis(as("owner", { reports: false }), { range: last30() })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(analysis(as("owner"), { range: { from: "2026-05-02", to: "2026-05-01" } })).rejects.toThrow();
  });

  it("keeps one company's figures out of another's", async () => {
    const other = await owner.query<{ id: string }>("insert into organizations (name, slug) values ('Other Co', 'other-co-analysis') returning id");
    const elsewhere = await analysis({ pool: app, orgId: other.rows[0]!.id, userId, role: "owner" }, { range: last30() });
    expect(elsewhere.sales.revenue.now).toBe(0);
    expect(elsewhere.products).toHaveLength(0);
    expect(elsewhere.money.owed.total).toBe(0);
  });
});
