import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appUrl, createPool, migrate, ownerUrl, seed, type Pool } from "@bos/db";
import {
  confirmOrder, createInvoice, createProduct, createQuote, createReturn, createSupplier, getOrder, getProduct, getSupplier, importTemplate, listCustomers, listInvoices,
  listProducts, listReturnable, listSuppliers, planImport, requestDeposit, runImport, shipOrder, updateProduct, updateSupplier, adjustStock, customerStatement, ForbiddenError,
  type Ctx, type Role,
} from "../src/index";

let owner: Pool;
let app: Pool;
let orgId: string;
let userId: string;
const as = (role: Role, features?: Ctx["features"]): Ctx => ({ pool: app, orgId, userId, role, features });
let taxed: string;
let untaxed: string;
let customer: string;

beforeAll(async () => {
  owner = createPool(ownerUrl());
  app = createPool(appUrl());
  await owner.query("drop schema public cascade; create schema public;");
  await migrate(owner);
  ({ orgId, userId } = await seed(owner));
  taxed = (await createProduct(as("owner"), { sku: "TX-1", name: "Hammer", price: 100 })).id;
  untaxed = (await createProduct(as("owner"), { sku: "NT-1", name: "Bread", price: 50, taxable: false })).id;
  for (const id of [taxed, untaxed]) await adjustStock(as("owner"), { productId: id, qtyDelta: 100, reason: "Opening", idempotencyKey: randomUUID() });
  customer = (await listCustomers(as("owner")))[0]!.id;
});
afterAll(async () => {
  await app.end();
  await owner.end();
});

describe("products that are not taxed", () => {
  it("are taxed unless marked otherwise, and keep the setting when other details are edited", async () => {
    expect((await getProduct(as("owner"), taxed))!.taxable).toBe(true);
    expect((await getProduct(as("owner"), untaxed))!.taxable).toBe(false);
    await updateProduct(as("owner"), untaxed, { sku: "NT-1", name: "Bread loaf", price: 50 });
    expect((await getProduct(as("owner"), untaxed))!.taxable).toBe(false);
  });

  it("charge tax only on the taxed lines of an order, its invoice and its deposit", async () => {
    const quote = await createQuote(as("sales"), { customerId: customer, taxRatePercent: 10, lines: [{ productId: taxed, qty: 2 }, { productId: untaxed, qty: 4 }] });
    const order = (await getOrder(as("sales"), quote.id))!;
    expect(order).toMatchObject({ subtotal: 400, tax: 20, total: 420 });
    expect(order.lines.map((l) => l.taxable)).toEqual([true, false]);
    const deposit = await requestDeposit(as("owner"), quote.id, 50);
    expect(deposit.amount).toBe(210);
    await confirmOrder(as("sales"), quote.id);
    await shipOrder(as("warehouse"), quote.id, { idempotencyKey: randomUUID() });
    const shipped = (await listInvoices(as("owner"), { orderId: quote.id })).find((i) => i.kind === "shipment")!;
    // 400 of goods, 20 tax, less the 210 deposit.
    expect(shipped.amount).toBe(210);
  });

  it("keep an order's tax as it was when the product's setting changes later", async () => {
    const quote = await createQuote(as("sales"), { customerId: customer, taxRatePercent: 10, lines: [{ productId: untaxed, qty: 2 }] });
    expect((await getOrder(as("sales"), quote.id))!.tax).toBe(0);
    await updateProduct(as("owner"), untaxed, { sku: "NT-1", name: "Bread loaf", price: 50, taxable: true });
    expect((await getOrder(as("sales"), quote.id))!.tax).toBe(0);
    const next = await createQuote(as("sales"), { customerId: customer, taxRatePercent: 10, lines: [{ productId: untaxed, qty: 2 }] });
    expect((await getOrder(as("sales"), next.id))!.tax).toBe(10);
    await updateProduct(as("owner"), untaxed, { sku: "NT-1", name: "Bread loaf", price: 50, taxable: false });
  });

  it("tax a hand-made invoice by line: product lines by the product, free-typed lines always", async () => {
    const made = await createInvoice(as("owner"), {
      customerId: customer, taxRatePercent: 10,
      lines: [{ description: "Hammer", qty: 1, unitPrice: 100, productId: taxed }, { description: "Bread", qty: 2, unitPrice: 50, productId: untaxed }, { description: "Delivery", qty: 1, unitPrice: 30 }],
    });
    expect(made.amount).toBe(243); // 230 of lines, tax on 130
  });

  it("give back only the tax that was charged when goods are returned", async () => {
    const quote = await createQuote(as("sales"), { customerId: customer, taxRatePercent: 10, lines: [{ productId: taxed, qty: 1 }, { productId: untaxed, qty: 2 }] });
    await confirmOrder(as("sales"), quote.id);
    await shipOrder(as("warehouse"), quote.id, { idempotencyKey: randomUUID() });
    const lines = await listReturnable(as("owner"), quote.id);
    const before = (await customerStatement(as("owner"), customer))!;
    const done = await createReturn(as("owner"), quote.id, { lines: lines.map((l) => ({ orderLineId: l.orderLineId, qty: 1 })), reason: "Both back", restock: true, credit: true, idempotencyKey: randomUUID() });
    expect(done.value).toBe(150);
    expect(done.creditAmount).toBe(160); // 100 + 10 tax, and 50 with none
    expect(before.owed - (await customerStatement(as("owner"), customer))!.owed).toBeCloseTo(160, 2);
  });
});

describe("supplier address", () => {
  it("is saved, kept when not mentioned, and cleared when sent blank", async () => {
    const { id } = await createSupplier(as("owner"), { name: "Mill Road Timber", address: "40 Mill Rd\nBangor, ME 04401" });
    expect((await getSupplier(as("owner"), id))!.address).toBe("40 Mill Rd\nBangor, ME 04401");
    await updateSupplier(as("owner"), id, { name: "Mill Road Timber", phone: "555-0300" });
    expect((await getSupplier(as("owner"), id))!.address).toBe("40 Mill Rd\nBangor, ME 04401");
    await updateSupplier(as("owner"), id, { name: "Mill Road Timber", address: " " });
    expect((await getSupplier(as("owner"), id))!.address).toBeNull();
  });
});

describe("importing suppliers and unpaid invoices", () => {
  it("imports suppliers once, with their address and lead time", async () => {
    const file = "Vendor,Email,Phone,Terms,Lead time,Address\nOak & Iron Supply,orders@oak.example,555-0400,Net 45,12,\"9 Forge St, Bath\"\noak & iron supply,,,,,\nBad Lead Co,,,,soon,\nRidgeline Fasteners,,,,,\nBad Mail Co,nope,,,,";
    const plan = await planImport(as("purchasing"), "suppliers", file);
    expect(plan.rows.map((r) => r.action)).toEqual(["add", "skip", "error", "skip", "error"]);
    await runImport(as("purchasing"), "suppliers", file, randomUUID());
    const made = (await listSuppliers(as("owner"))).find((s) => s.name === "Oak & Iron Supply")!;
    expect(made).toMatchObject({ email: "orders@oak.example", phone: "555-0400", paymentTerms: "Net 45", leadTimeDays: 12, address: "9 Forge St, Bath" });
    expect((await runImport(as("purchasing"), "suppliers", file, randomUUID())).add).toBe(0);
    await expect(planImport(as("sales"), "suppliers", file)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await planImport(as("owner"), "suppliers", importTemplate("suppliers").replace("Summit Plumbing Supply", "Template Supplier"))).errors).toBe(0);
  });

  it("brings unpaid invoices forward with their own dates, as money owed", async () => {
    const name = (await listCustomers(as("owner")))[1]!.name;
    const id = (await listCustomers(as("owner")))[1]!.id;
    const before = (await customerStatement(as("owner"), id))!;
    const file = [
      "Customer,Balance,Invoice #,Date,Due",
      `${name},"1,250.00",10482,2026-01-15,2026-02-14`,
      `${name.toUpperCase()},80.5,10490,3/1/2031,3/31/2031`,
      `${name},40,,,`,
      "Nobody Ltd,10,1,,",
      `${name},abc,2,,`,
      `${name},10,3,2026-13-40,`,
      `${name},10,4,2026-02-01,2026-01-01`,
      `${name},-5,5,,`,
      `${name},1250,10482,,`,
    ].join("\n");
    const plan = await planImport(as("owner"), "invoices", file);
    expect(plan.rows.map((r) => r.action)).toEqual(["add", "add", "add", "error", "error", "error", "error", "error", "skip"]);
    expect(plan.rows[3]!.note).toContain("no customer called");
    await runImport(as("owner"), "invoices", file, randomUUID());
    const after = (await customerStatement(as("owner"), id))!;
    expect(after.owed - before.owed).toBeCloseTo(1370.5, 2);
    // The January invoice is long overdue; the 2031 one is not due yet.
    expect(after.overdue - before.overdue).toBeCloseTo(1250, 2);
    const old = after.invoices.find((i) => i.amount === 1250)!;
    expect(old.issuedAt.toISOString().slice(0, 10)).toBe("2026-01-15");
    expect(old.state).toBe("overdue");
    expect(old.number).toMatch(/^INV-\d{6}$/);
    // Importing the same file again adds nothing.
    const again = await runImport(as("owner"), "invoices", file, randomUUID());
    expect([again.add, again.skip]).toEqual([0, 4]);
    expect((await customerStatement(as("owner"), id))!.owed).toBeCloseTo(after.owed, 2);
    await expect(planImport(as("sales"), "invoices", file)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await planImport(as("owner"), "invoices", importTemplate("invoices"))).errors).toBe(0);
  });

  it("reads the Taxed column for products", async () => {
    await runImport(as("owner"), "products", "Code,Name,Price,Taxed\nIMP-T,Taxed thing,5,yes\nIMP-N,Untaxed thing,5,No\nIMP-B,Blank means taxed,5,", randomUUID());
    const got = new Map((await listProducts(as("owner"))).map((p) => [p.sku, p.taxable]));
    expect([got.get("IMP-T"), got.get("IMP-N"), got.get("IMP-B")]).toEqual([true, false, true]);
  });
});
