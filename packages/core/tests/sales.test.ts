import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appUrl, createPool, migrate, ownerUrl, seed, type Pool } from "@bos/db";
import {
  adjustStock,
  cancelOrder,
  confirmOrder,
  createQuote,
  ForbiddenError,
  getOrder,
  getProduct,
  listCustomers,
  listMovements,
  listOrders,
  listProducts,
  overview,
  reconcileStock,
  reserveAvailable,
  shipOrder,
  StateError,
  ValidationError,
  type Ctx,
  type Role,
} from "../src/index";

let owner: Pool;
let app: Pool;
let orgId: string;
let userId: string;
let bayside: string;
let otherCustomer: string;
let otherProduct: string;
let otherOrder: string;
const sku = new Map<string, string>();

const as = (role: Role): Ctx => ({ pool: app, orgId, userId, role });
const id = (code: string): string => sku.get(code)!;
const stock = async (code: string) => (await getProduct(as("owner"), id(code)))!;
const quote = (lines: [string, number][], taxRatePercent = 0) =>
  createQuote(as("sales"), {
    customerId: bayside,
    taxRatePercent,
    lines: lines.map(([code, qty]) => ({ productId: id(code), qty })),
  });

beforeAll(async () => {
  owner = createPool(ownerUrl());
  app = createPool(appUrl());
  app.options.max = 20;
  await owner.query("drop schema public cascade; create schema public;");
  await migrate(owner);
  ({ orgId, userId } = await seed(owner));
  for (const product of await listProducts(as("owner"))) sku.set(product.sku, product.id);
  bayside = (await listCustomers(as("owner"))).find((c) => c.name === "Bayside Hardware")!.id;
  const other = await owner.query<{ id: string }>(
    "insert into organizations (name, slug) values ('Other Co', 'other-co') returning id",
  );
  const otherOrg = other.rows[0]!.id;
  otherCustomer = (
    await owner.query<{ id: string }>("insert into customers (org_id, name) values ($1, 'Secret') returning id", [otherOrg])
  ).rows[0]!.id;
  otherProduct = (
    await owner.query<{ id: string }>("insert into products (org_id, sku, name) values ($1, 'X-1', 'Secret') returning id", [
      otherOrg,
    ])
  ).rows[0]!.id;
  otherOrder = (
    await owner.query<{ id: string }>(
      "insert into sales_orders (org_id, number, customer_id) values ($1, 'SO-000001', $2) returning id",
      [otherOrg, otherCustomer],
    )
  ).rows[0]!.id;
});

afterAll(async () => {
  await owner.end();
  await app.end();
});

describe("a full order, from quote to shipped", () => {
  let orderId: string;

  it("creates a numbered quote with correct totals and reserves nothing", async () => {
    const created = await quote(
      [
        ["FS-DS3-100", 40],
        ["GL-WK-L", 60],
        ["PL-CEM-16", 24],
        ["TL-UKB-50", 30],
      ],
      6.25,
    );
    orderId = created.id;
    expect(created.number).toBe("SO-000001");
    const order = (await getOrder(as("sales"), orderId))!;
    expect(order).toMatchObject({ status: "quote", subtotal: 1088.2, tax: 68.01, total: 1156.21, unitsOrdered: 154 });
    expect(order.lines.map((l) => l.amount)).toEqual([340, 255, 163.2, 330]);
    expect((await stock("FS-DS3-100")).reserved).toBe(0);
  });

  it("confirming reserves what is available and backorders the rest", async () => {
    expect(await confirmOrder(as("sales"), orderId)).toEqual({ reserved: 148 });
    const order = (await getOrder(as("sales"), orderId))!;
    expect(order).toMatchObject({ status: "confirmed", unitsReserved: 148, unitsBackordered: 6 });
    const cement = order.lines.find((l) => l.sku === "PL-CEM-16")!;
    expect(cement).toMatchObject({ qty: 24, reserved: 18, backorder: 6, availableNow: 0 });
    expect(await stock("PL-CEM-16")).toMatchObject({ onHand: 18, reserved: 18, available: 0 });
    expect(await stock("FS-DS3-100")).toMatchObject({ onHand: 212, reserved: 40, available: 172 });
    expect(await reconcileStock(as("owner"))).toEqual([]);
  });

  it("cannot be confirmed twice", async () => {
    await expect(confirmOrder(as("sales"), orderId)).rejects.toBeInstanceOf(StateError);
    expect((await stock("FS-DS3-100")).reserved).toBe(40);
  });

  it("shipping takes reserved stock out of the warehouse and leaves the backorder open", async () => {
    const key = randomUUID();
    const shipped = await shipOrder(as("warehouse"), orderId, { idempotencyKey: key });
    expect(shipped).toMatchObject({ shipmentNumber: "SH-000001", units: 148, replayed: false });
    const order = (await getOrder(as("owner"), orderId))!;
    expect(order).toMatchObject({ status: "partially_shipped", unitsShipped: 148, unitsReserved: 0, unitsBackordered: 6 });
    expect(order.shipments).toHaveLength(1);
    expect(order.shipments[0]).toMatchObject({ number: "SH-000001", units: 148 });
    expect(await stock("FS-DS3-100")).toMatchObject({ onHand: 172, reserved: 0, available: 172 });
    expect(await stock("PL-CEM-16")).toMatchObject({ onHand: 0, reserved: 0 });
    expect((await listMovements(as("owner"), id("FS-DS3-100")))[0]).toMatchObject({ kind: "shipment", qtyDelta: -40 });

    const again = await shipOrder(as("warehouse"), orderId, { idempotencyKey: key });
    expect(again).toMatchObject({ shipmentNumber: "SH-000001", units: 148, replayed: true });
    expect((await stock("FS-DS3-100")).onHand).toBe(172);
    expect(await reconcileStock(as("owner"))).toEqual([]);
  });

  it("refuses to ship when nothing is reserved", async () => {
    await expect(shipOrder(as("warehouse"), orderId, { idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(StateError);
  });

  it("reserves the backorder once stock arrives, then ships and completes", async () => {
    expect(await reserveAvailable(as("sales"), orderId)).toEqual({ reserved: 0 });
    await adjustStock(as("owner"), { productId: id("PL-CEM-16"), qtyDelta: 48, reason: "Delivery", idempotencyKey: randomUUID() });
    expect(await reserveAvailable(as("sales"), orderId)).toEqual({ reserved: 6 });
    expect(await reserveAvailable(as("sales"), orderId)).toEqual({ reserved: 0 });
    const shipped = await shipOrder(as("owner"), orderId, { idempotencyKey: randomUUID() });
    expect(shipped).toMatchObject({ shipmentNumber: "SH-000002", units: 6 });
    const order = (await getOrder(as("owner"), orderId))!;
    expect(order).toMatchObject({ status: "shipped", unitsShipped: 154, unitsBackordered: 0 });
    expect(await stock("PL-CEM-16")).toMatchObject({ onHand: 42, reserved: 0 });
    expect(await reconcileStock(as("owner"))).toEqual([]);
  });

  it("cannot be cancelled after shipping", async () => {
    await expect(cancelOrder(as("sales"), orderId)).rejects.toBeInstanceOf(StateError);
  });

  it("is recorded in the audit log", async () => {
    const actions = await owner.query<{ action: string }>(
      "select action from audit_log where entity_id = $1 order by created_at, action",
      [orderId],
    );
    expect(actions.rows.map((r) => r.action)).toEqual([
      "sales_order.created",
      "sales_order.confirmed",
      "sales_order.shipped",
      "sales_order.reserved",
      "sales_order.shipped",
    ]);
  });
});

describe("cancelling", () => {
  it("a quote is cancelled without touching stock", async () => {
    const { id: orderId } = await quote([["GL-WK-L", 10]]);
    expect(await cancelOrder(as("sales"), orderId)).toEqual({ released: 0 });
    expect((await getOrder(as("sales"), orderId))!.status).toBe("cancelled");
    await expect(confirmOrder(as("sales"), orderId)).rejects.toBeInstanceOf(StateError);
  });

  it("a confirmed order gives its reserved stock back, once", async () => {
    const before = (await stock("GL-WK-L")).available;
    const { id: orderId } = await quote([["GL-WK-L", 25]]);
    await confirmOrder(as("sales"), orderId);
    expect((await stock("GL-WK-L")).available).toBe(before - 25);
    expect(await cancelOrder(as("sales"), orderId)).toEqual({ released: 25 });
    expect(await cancelOrder(as("sales"), orderId)).toEqual({ released: 0 });
    expect((await stock("GL-WK-L")).available).toBe(before);
    expect((await getOrder(as("sales"), orderId))!.unitsReserved).toBe(0);
    await expect(shipOrder(as("warehouse"), orderId, { idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(StateError);
    expect(await reconcileStock(as("owner"))).toEqual([]);
  });
});

describe("numbering and concurrency", () => {
  it("ten quotes created at once get ten consecutive numbers", async () => {
    const before = (await listOrders(as("owner"))).length;
    const created = await Promise.all(Array.from({ length: 10 }, () => quote([["GD-SOIL-20", 1]])));
    const numbers = created.map((c) => Number(c.number.slice(3))).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 10 }, (_, n) => before + 1 + n));
  });

  it("orders confirmed at once never reserve more than exists", async () => {
    const available = (await stock("GD-HOSE-50")).available;
    expect(available).toBe(31);
    const quotes = await Promise.all(Array.from({ length: 8 }, () => quote([["GD-HOSE-50", 10]])));
    await Promise.all(quotes.map((q) => confirmOrder(as("sales"), q.id)));
    const orders = await Promise.all(quotes.map((q) => getOrder(as("owner"), q.id)));
    const reserved = orders.map((o) => o!.unitsReserved).sort((a, b) => a - b);
    expect(reserved).toEqual([0, 0, 0, 0, 1, 10, 10, 10]);
    expect(await stock("GD-HOSE-50")).toMatchObject({ onHand: 31, reserved: 31, available: 0 });
    expect(await reconcileStock(as("owner"))).toEqual([]);
  });

  it("the same ship request sent five times at once ships once", async () => {
    const { id: orderId } = await quote([["TL-UKB-50", 5]]);
    await confirmOrder(as("sales"), orderId);
    const before = (await stock("TL-UKB-50")).onHand;
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => shipOrder(as("warehouse"), orderId, { idempotencyKey: key })),
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.shipmentNumber)).size).toBe(1);
    expect((await stock("TL-UKB-50")).onHand).toBe(before - 5);
    expect((await getOrder(as("owner"), orderId))!.shipments).toHaveLength(1);
    expect(await reconcileStock(as("owner"))).toEqual([]);
  });
});

describe("rules and access", () => {
  it("rejects bad input without creating anything", async () => {
    const before = (await listOrders(as("owner"))).length;
    const make = (lines: { productId: string; qty: number; unitPrice?: number }[], extra = {}) =>
      createQuote(as("sales"), { customerId: bayside, lines, ...extra });
    await expect(make([])).rejects.toBeInstanceOf(ValidationError);
    await expect(make([{ productId: id("GL-WK-L"), qty: 0 }])).rejects.toBeInstanceOf(ValidationError);
    await expect(make([{ productId: id("GL-WK-L"), qty: -3 }])).rejects.toBeInstanceOf(ValidationError);
    await expect(make([{ productId: id("GL-WK-L"), qty: 1, unitPrice: -1 }])).rejects.toBeInstanceOf(ValidationError);
    await expect(make([{ productId: id("GL-WK-L"), qty: 1 }], { taxRatePercent: 100 })).rejects.toBeInstanceOf(ValidationError);
    await expect(make([{ productId: otherProduct, qty: 1 }])).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createQuote(as("sales"), { customerId: otherCustomer, lines: [{ productId: id("GL-WK-L"), qty: 1 }] }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect((await listOrders(as("owner"))).length).toBe(before);
  });

  it("uses the catalog price unless one is given", async () => {
    const { id: orderId } = await createQuote(as("sales"), {
      customerId: bayside,
      lines: [
        { productId: id("GL-WK-L"), qty: 2 },
        { productId: id("GL-WK-L"), qty: 2, unitPrice: 3.5 },
      ],
    });
    expect((await getOrder(as("sales"), orderId))!.lines.map((l) => l.unitPrice)).toEqual([4.25, 3.5]);
  });

  it("enforces who may create, confirm and ship", async () => {
    const lines = [{ productId: id("GL-WK-L"), qty: 1 }];
    for (const role of ["viewer", "warehouse", "purchasing"] as const) {
      await expect(createQuote(as(role), { customerId: bayside, lines })).rejects.toBeInstanceOf(ForbiddenError);
    }
    const { id: orderId } = await quote([["GL-WK-L", 1]]);
    await expect(confirmOrder(as("warehouse"), orderId)).rejects.toBeInstanceOf(ForbiddenError);
    await confirmOrder(as("sales"), orderId);
    await expect(shipOrder(as("sales"), orderId, { idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(shipOrder(as("viewer"), orderId, { idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await getOrder(as("viewer"), orderId))!.status).toBe("confirmed");
  });

  it("cannot see or act on another company's order", async () => {
    expect(await getOrder(as("owner"), otherOrder)).toBeNull();
    await expect(confirmOrder(as("owner"), otherOrder)).rejects.toBeInstanceOf(StateError);
    await expect(shipOrder(as("owner"), otherOrder, { idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(StateError);
    await expect(cancelOrder(as("owner"), otherOrder)).rejects.toBeInstanceOf(StateError);
    const untouched = await owner.query("select status from sales_orders where id = $1", [otherOrder]);
    expect(untouched.rows[0].status).toBe("quote");
    expect((await listOrders(as("owner"))).some((o) => o.id === otherOrder)).toBe(false);
  });

  it("lists by status and customer, and feeds the Home counts", async () => {
    const open = await listOrders(as("owner"), { status: "open" });
    expect(open.every((o) => o.status === "confirmed" || o.status === "partially_shipped")).toBe(true);
    expect((await listOrders(as("owner"), { customerId: bayside })).length).toBe((await listOrders(as("owner"))).length);
    const counts = await overview(as("owner"));
    expect(counts.openOrders).toBe(open.length);
    expect(counts.readyToShip).toBe(open.filter((o) => o.unitsReserved > 0).length);
  });
});
