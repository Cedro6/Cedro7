import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appUrl, createPool, migrate, ownerUrl, seed, type Pool } from "@bos/db";
import { attention, confirmOrder, createQuote, listCustomers, listProducts, salesTrend, shipOrder, type Ctx, type Role } from "../src/index";

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

describe("home figures", () => {
  it("adds a newly confirmed order to today and to this week, before tax", async () => {
    const before = (await salesTrend(as("owner")))!;
    expect(before.days).toHaveLength(21);
    const product = (await listProducts(as("owner")))[0]!;
    const customer = (await listCustomers(as("owner")))[0]!;
    const quote = await createQuote(as("sales"), { customerId: customer.id, taxRatePercent: 8, lines: [{ productId: product.id, qty: 2, unitPrice: 50 }] });
    expect((await salesTrend(as("owner")))!.thisWeek).toBe(before.thisWeek); // a quote is not a sale
    await confirmOrder(as("sales"), quote.id);
    const after = (await salesTrend(as("owner")))!;
    expect(after.thisWeek - before.thisWeek).toBe(100);
    expect(after.days[20]!.total - before.days[20]!.total).toBe(100);
    expect(after.lastWeek).toBe(before.lastWeek);
  });

  it("flags an invoice once it is overdue, with what is owed", async () => {
    const product = (await listProducts(as("owner")))[0]!;
    const customer = (await listCustomers(as("owner")))[0]!;
    const quote = await createQuote(as("sales"), { customerId: customer.id, lines: [{ productId: product.id, qty: 1, unitPrice: 40 }] });
    await confirmOrder(as("sales"), quote.id);
    await shipOrder(as("warehouse"), quote.id, { idempotencyKey: randomUUID() });
    await owner.query("update invoices set due_at = now() - interval '5 days' where order_id = $1", [quote.id]);
    const item = (await attention(as("owner"))).find((i) => i.kind === "overdue_invoice")!;
    expect(item.title).toMatch(/invoices? overdue/);
    expect(item.detail).toContain("5 days late");
  });

  it("leaves stock and purchasing items out when those features are off", async () => {
    const kinds = (await attention(as("owner", { stock: false, purchasing: false }))).map((i) => i.kind);
    expect(kinds).not.toContain("low_stock");
    expect(kinds).not.toContain("ready_to_ship");
    expect(kinds).not.toContain("late_purchase_order");
  });

  it("names a customer who has not ordered in over a month", async () => {
    const customers = await listCustomers(as("owner"));
    await owner.query("update sales_orders set created_at = now() - interval '45 days' where customer_id = $1", [customers[1]!.id]);
    const had = await owner.query("select 1 from sales_orders where customer_id = $1", [customers[1]!.id]);
    const item = (await attention(as("owner"))).find((i) => i.kind === "quiet_customer");
    if (had.rowCount) expect(item?.title).toContain("quiet for 45 days");
  });
});
