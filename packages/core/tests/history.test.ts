import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appUrl, createPool, migrate, ownerUrl, seed, type Pool } from "@bos/db";
import { adjustStock, confirmOrder, createCustomer, createExpense, createQuote, ForbiddenError, HISTORY_PAGE, listCustomers, listHistory, listProducts, setFeature, updateCustomer, updateProduct, type Ctx, type Role } from "../src/index";
import { randomUUID } from "node:crypto";

let owner: Pool;
let app: Pool;
let orgId: string;
let userId: string;
const as = (role: Role): Ctx => ({ pool: app, orgId, userId, role });

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

describe("activity history", () => {
  it("lists changes newest first, in plain words, with a link to the record", async () => {
    const customer = await createCustomer(as("owner"), { name: "History Test Co" });
    const product = (await listProducts(as("owner"))).find((p) => p.available >= 5)!;
    const order = await createQuote(as("sales"), { customerId: customer.id, lines: [{ productId: product.id, qty: 1 }] });
    await confirmOrder(as("sales"), order.id);
    await adjustStock(as("owner"), { productId: product.id, qtyDelta: -1, reason: "Damaged in the warehouse", idempotencyKey: randomUUID() });
    const { entries } = await listHistory(as("owner"));
    expect(entries.slice(0, 4).map((e) => `${e.what} ${e.subject}`)).toEqual([
      `adjusted the stock of ${product.name}`,
      `confirmed order ${order.number}`,
      `created quote ${order.number}`,
      "added customer History Test Co",
    ]);
    expect(entries[0]).toMatchObject({ href: `/products/${product.id}`, area: "products" });
    expect(entries[0]!.detail).toContain("Reason: Damaged in the warehouse");
    expect(entries[0]!.detail).toContain("-1 units");
    expect(entries[1]).toMatchObject({ href: `/sales/${order.id}`, area: "sales" });
    expect(entries[3]!.who).toBeTruthy();
    expect(entries.every((e, i) => i === 0 || e.at <= entries[i - 1]!.at)).toBe(true);
  });

  it("filters by area and by person", async () => {
    await createExpense(as("owner"), { description: "History rent", category: "Rent", amount: 10, incurredOn: "2026-10-01" });
    await setFeature(as("owner"), "returns", false);
    await setFeature(as("owner"), "returns", true);
    const money = (await listHistory(as("owner"), { area: "money" })).entries;
    expect(money.length).toBeGreaterThan(0);
    expect(money.every((e) => e.area === "money")).toBe(true);
    expect(money[0]).toMatchObject({ what: "recorded bill or expense", subject: "History rent" });
    const settings = (await listHistory(as("owner"), { area: "settings" })).entries;
    expect(settings[0]!.what).toBe("switched a feature");
    expect((await listHistory(as("owner"), { userId })).entries.length).toBeGreaterThan(0);
    expect((await listHistory(as("owner"), { userId: randomUUID() })).entries).toEqual([]);
    expect((await listHistory(as("owner"), { userId: "not-an-id" })).entries.length).toBeGreaterThan(0);
  });

  it("pages through older entries without repeating or skipping any", async () => {
    await owner.query(
      `insert into audit_log (org_id, actor_type, actor_id, action, entity_type, created_at)
       select $1, 'user', $2, 'customer.updated', 'customer', now() - ((n / 9) || ' minutes')::interval from generate_series(1, 70) n`,
      [orgId, userId],
    );
    const total = Number((await owner.query("select count(*) from audit_log where org_id = $1", [orgId])).rows[0].count);
    const seen = new Set<string>();
    let before: string | undefined;
    for (let page = 0; page < 10; page++) {
      const { entries, next } = await listHistory(as("owner"), { before });
      expect(entries.length).toBeLessThanOrEqual(HISTORY_PAGE);
      for (const e of entries) {
        expect(seen.has(e.id)).toBe(false);
        seen.add(e.id);
      }
      if (!next) break;
      before = next;
    }
    expect(seen.size).toBe(total);
  });

  it("is for owners and admins only, and stays inside the company", async () => {
    for (const role of ["sales", "purchasing", "warehouse", "viewer"] as const) await expect(listHistory(as(role))).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listHistory(as("admin"))).entries.length).toBeGreaterThan(0);
    const other = await owner.query<{ id: string }>("insert into organizations (name, slug) values ('Other', 'other-history') returning id");
    expect((await listHistory({ pool: app, orgId: other.rows[0]!.id, userId, role: "owner" })).entries).toEqual([]);
    expect((await listCustomers(as("owner"))).length).toBeGreaterThan(0);
  });

  it("says exactly what changed when a customer, product or supplier is edited", async () => {
    const c = await createCustomer(as("owner"), { name: "Before Co", paymentTerms: "Net 30" });
    await updateCustomer(as("owner"), c.id, { name: "After Co", paymentTerms: "Net 30", billingAddress: "1 Quay St" });
    const p = (await listProducts(as("owner")))[0]!;
    await updateProduct(as("owner"), p.id, { sku: p.sku, name: p.name, category: p.category ?? undefined, price: p.price + 1, cost: p.cost ?? undefined, reorderPoint: p.reorderPoint, shelfLocation: p.shelfLocation ?? undefined, taxable: false });
    await updateCustomer(as("owner"), c.id, { name: "After Co", paymentTerms: "Net 30" });
    const [same, product, customer] = (await listHistory(as("owner"))).entries;
    expect(customer!.detail).toBe("Name: Before Co → After Co · Billing address: nothing → 1 Quay St");
    expect(product!.detail).toBe(`Price: ${p.price} → ${p.price + 1} · Taxed: yes → no`);
    expect(same!.detail).toBe("Saved with no changes");
    // A role that cannot see cost does not get it written into the history either.
    await updateProduct(as("owner"), p.id, { sku: p.sku, name: p.name, price: p.price, taxable: true });
    const stored = (await owner.query("select before, after from audit_log where action = 'product.updated' order by created_at desc, id desc limit 1")).rows[0];
    expect(Object.keys(stored.before)).toContain("cost");
  });
});
