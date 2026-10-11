import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appUrl, createPool, migrate, ownerUrl, seed, type Pool } from "@bos/db";
import { cancelOrder, confirmOrder, createQuote, ForbiddenError, listCustomers, listProducts, recordPayment, listInvoices, report, shipOrder, type Ctx, type Role } from "../src/index";

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

describe("reports", () => {
  it("counts confirmed sales in the period, with margin, and leaves out quotes and cancelled orders", async () => {
    const before = await report(as("owner"), 30);
    const product = (await listProducts(as("owner"))).find((p) => p.available >= 10 && (p.cost ?? 0) > 0)!;
    const customer = (await listCustomers(as("owner")))[0]!;
    const make = () => createQuote(as("sales"), { customerId: customer.id, taxRatePercent: 8, lines: [{ productId: product.id, qty: 2, unitPrice: 100 }] });
    await make(); // stays a quote
    const cancelled = await make();
    await confirmOrder(as("sales"), cancelled.id);
    await cancelOrder(as("sales"), cancelled.id);
    const kept = await make();
    await confirmOrder(as("sales"), kept.id);
    const after = await report(as("owner"), 30);
    expect(after.sales.orders - before.sales.orders).toBe(1);
    expect(after.sales.revenue - before.sales.revenue).toBe(200);
    const row = after.topProducts.find((p) => p.id === product.id)!;
    const was = before.topProducts.find((p) => p.id === product.id);
    expect(row.units - (was?.units ?? 0)).toBe(2);
    expect(row.margin! - (was?.margin ?? 0)).toBeCloseTo(200 - 2 * product.cost!, 2);
    expect(after.byMonth.reduce((sum, m) => sum + m.revenue, 0)).toBeCloseTo(after.sales.revenue, 2);
    expect(after.topCustomers.find((c) => c.id === customer.id)!.revenue).toBeGreaterThanOrEqual(200);
  });

  it("puts last period's sales in the comparison, not in this period", async () => {
    const before = await report(as("owner"), 30);
    const product = (await listProducts(as("owner"))).find((p) => p.available >= 10)!;
    const customer = (await listCustomers(as("owner")))[0]!;
    const old = await createQuote(as("sales"), { customerId: customer.id, lines: [{ productId: product.id, qty: 1, unitPrice: 70 }] });
    await confirmOrder(as("sales"), old.id);
    await owner.query("update sales_orders set confirmed_at = now() - interval '45 days' where id = $1", [old.id]);
    const after = await report(as("owner"), 30);
    expect(after.sales.revenue).toBeCloseTo(before.sales.revenue, 2);
    expect(after.sales.previousRevenue - before.sales.previousRevenue).toBeCloseTo(70, 2);
    expect((await report(as("owner"), 90)).sales.revenue).toBeGreaterThanOrEqual(after.sales.revenue + 70);
  });

  it("ages what customers owe and drops an invoice once it is paid", async () => {
    const product = (await listProducts(as("owner"))).find((p) => p.available >= 10)!;
    const customer = (await listCustomers(as("owner")))[0]!;
    const order = await createQuote(as("sales"), { customerId: customer.id, lines: [{ productId: product.id, qty: 1, unitPrice: 50 }] });
    await confirmOrder(as("sales"), order.id);
    await shipOrder(as("warehouse"), order.id, { idempotencyKey: randomUUID() });
    const invoice = (await listInvoices(as("owner"), { orderId: order.id }))[0]!;
    await owner.query("update invoices set due_at = now() - interval '40 days' where id = $1", [invoice.id]);
    const owing = await report(as("owner"), 30);
    expect(owing.receivables.late60).toBeGreaterThanOrEqual(50);
    await recordPayment(as("owner"), invoice.id, { amount: 50, method: "Check", idempotencyKey: randomUUID() });
    const paid = await report(as("owner"), 30);
    expect(owing.receivables.late60 - paid.receivables.late60).toBeCloseTo(50, 2);
    expect(owing.receivables.total - paid.receivables.total).toBeCloseTo(50, 2);
  });

  it("hides cost-based figures from sales and whole sections when a feature is off", async () => {
    const sales = await report(as("sales"), 30);
    expect(sales.stock).toBeNull();
    expect(sales.topProducts.every((p) => p.margin === null)).toBe(true);
    const lean = await report(as("owner", { stock: false, purchasing: false }), 30);
    expect(lean.stock).toBeNull();
    expect(lean.purchasing).toBeNull();
    expect((await report(as("owner"), 30)).stock!.value).toBeGreaterThan(0);
    await expect(report(as("owner", { reports: false }), 30)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(report(as("warehouse", { reports: false }), 30)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
