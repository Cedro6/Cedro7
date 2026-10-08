import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appUrl, createPool, migrate, ownerUrl, seed, type Pool } from "@bos/db";
import {
  approvePurchaseOrder,
  cancelPurchaseOrder,
  confirmOrder,
  createPurchaseOrder,
  createQuote,
  createSupplier,
  ForbiddenError,
  getOrder,
  getProduct,
  getPurchaseOrder,
  listCustomers,
  listMovements,
  listProducts,
  listPurchaseOrders,
  listSuppliers,
  markPurchaseOrderSent,
  overview,
  receivePurchaseOrder,
  reconcileStock,
  StateError,
  submitPurchaseOrder,
  ValidationError,
  type Ctx,
  type Role,
} from "../src/index";

let owner: Pool;
let app: Pool;
let orgId: string;
let userId: string;
let supplierId: string;
let customerId: string;
let otherSupplier: string;
let otherPo: string;
const sku = new Map<string, string>();

const as = (role: Role): Ctx => ({ pool: app, orgId, userId, role });
const id = (code: string): string => sku.get(code)!;
const product = async (code: string) => (await getProduct(as("owner"), id(code)))!;
const po = async (orderId: string) => (await getPurchaseOrder(as("owner"), orderId))!;
const draft = (lines: [string, number, number?][]) =>
  createPurchaseOrder(as("purchasing"), {
    supplierId,
    lines: lines.map(([code, qty, unitCost]) => ({ productId: id(code), qty, unitCost })),
  });
const receiveAll = async (orderId: string, role: Role = "warehouse") => {
  const order = await po(orderId);
  return receivePurchaseOrder(as(role), orderId, {
    idempotencyKey: randomUUID(),
    lines: order.lines.filter((l) => l.outstanding > 0).map((l) => ({ lineId: l.id, qty: l.outstanding })),
  });
};

beforeAll(async () => {
  owner = createPool(ownerUrl());
  app = createPool(appUrl());
  app.options.max = 20;
  await owner.query("drop schema public cascade; create schema public;");
  await migrate(owner);
  ({ orgId, userId } = await seed(owner));
  for (const p of await listProducts(as("owner"))) sku.set(p.sku, p.id);
  supplierId = (await listSuppliers(as("owner"))).find((s) => s.name === "Summit Plumbing Supply")!.id;
  customerId = (await listCustomers(as("owner")))[0]!.id;
  const other = await owner.query<{ id: string }>(
    "insert into organizations (name, slug) values ('Other Co', 'other-co') returning id",
  );
  otherSupplier = (
    await owner.query<{ id: string }>("insert into suppliers (org_id, name) values ($1, 'Secret') returning id", [
      other.rows[0]!.id,
    ])
  ).rows[0]!.id;
  otherPo = (
    await owner.query<{ id: string }>(
      "insert into purchase_orders (org_id, number, supplier_id, status) values ($1, 'PO-000001', $2, 'approved') returning id",
      [other.rows[0]!.id, otherSupplier],
    )
  ).rows[0]!.id;
});

afterAll(async () => {
  await owner.end();
  await app.end();
});

describe("suppliers", () => {
  it("are seeded, listed and can be added", async () => {
    expect((await listSuppliers(as("viewer"))).map((s) => s.name)).toEqual([
      "Greenleaf Garden Wholesale",
      "Ridgeline Fasteners",
      "Summit Plumbing Supply",
    ]);
    await createSupplier(as("purchasing"), { name: " Coastal Paper ", leadTimeDays: 4 });
    expect((await listSuppliers(as("owner"))).find((s) => s.name === "Coastal Paper")).toMatchObject({ leadTimeDays: 4 });
    await expect(createSupplier(as("purchasing"), { name: " " })).rejects.toBeInstanceOf(ValidationError);
    await expect(createSupplier(as("warehouse"), { name: "X" })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("approval", () => {
  it("a small order is approved when submitted", async () => {
    const created = await draft([["PL-CEM-16", 48, 4.5]]);
    expect(created.number).toBe("PO-000001");
    expect(await po(created.id)).toMatchObject({ status: "draft", total: 216, unitsOrdered: 48, approvalLimit: 1000 });
    expect(await submitPurchaseOrder(as("purchasing"), created.id)).toEqual({ status: "approved" });
    await expect(submitPurchaseOrder(as("purchasing"), created.id)).rejects.toBeInstanceOf(StateError);
  });

  it("a large order waits for an owner or admin", async () => {
    const created = await draft([["GD-HOSE-50", 100]]);
    expect((await po(created.id)).total).toBe(1420);
    expect(await submitPurchaseOrder(as("purchasing"), created.id)).toEqual({ status: "pending_approval" });
    await expect(approvePurchaseOrder(as("purchasing"), created.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(markPurchaseOrderSent(as("purchasing"), created.id)).rejects.toBeInstanceOf(StateError);
    await expect(receiveAll(created.id)).rejects.toBeInstanceOf(StateError);
    expect((await product("GD-HOSE-50")).onOrder).toBe(0);
    await approvePurchaseOrder(as("admin"), created.id);
    expect(await po(created.id)).toMatchObject({ status: "approved", approvedBy: "Amara Okafor" });
    expect((await product("GD-HOSE-50")).onOrder).toBe(100);
    await cancelPurchaseOrder(as("purchasing"), created.id);
    expect((await product("GD-HOSE-50")).onOrder).toBe(0);
  });

  it("an owner's own large order is approved on submit", async () => {
    const created = await draft([["GD-HOSE-50", 100]]);
    expect(await submitPurchaseOrder(as("owner"), created.id)).toEqual({ status: "approved" });
    await cancelPurchaseOrder(as("owner"), created.id);
  });

  it("a draft cannot be received", async () => {
    const created = await draft([["GL-WK-L", 5]]);
    await expect(receiveAll(created.id)).rejects.toBeInstanceOf(StateError);
    await cancelPurchaseOrder(as("purchasing"), created.id);
    await expect(submitPurchaseOrder(as("purchasing"), created.id)).rejects.toBeInstanceOf(StateError);
  });
});

describe("receiving", () => {
  let orderId: string;
  let lineId: string;

  it("a partial receipt raises stock, records cost and updates the average", async () => {
    orderId = (await listPurchaseOrders(as("owner"))).find((o) => o.number === "PO-000001")!.id;
    await markPurchaseOrderSent(as("purchasing"), orderId);
    lineId = (await po(orderId)).lines[0]!.id;
    expect(await product("PL-CEM-16")).toMatchObject({ onHand: 18, cost: 4.05, onOrder: 48 });
    const key = randomUUID();
    const result = await receivePurchaseOrder(as("warehouse"), orderId, { idempotencyKey: key, lines: [{ lineId, qty: 30 }] });
    expect(result).toEqual({ receiptNumber: "RC-000001", units: 30, allocatedToBackorders: 0, replayed: false });
    // (18 x 4.05 + 30 x 4.50) / 48 = 4.33125
    expect(await product("PL-CEM-16")).toMatchObject({ onHand: 48, cost: 4.3313, onOrder: 18 });
    expect(await po(orderId)).toMatchObject({ status: "partially_received", unitsReceived: 30 });
    expect((await listMovements(as("owner"), id("PL-CEM-16")))[0]).toMatchObject({ kind: "receipt", qtyDelta: 30 });

    const again = await receivePurchaseOrder(as("warehouse"), orderId, { idempotencyKey: key, lines: [{ lineId, qty: 30 }] });
    expect(again).toMatchObject({ receiptNumber: "RC-000001", replayed: true });
    expect((await product("PL-CEM-16")).onHand).toBe(48);
  });

  it("refuses more than is outstanding, and bad quantities", async () => {
    const attempt = (qty: number) =>
      receivePurchaseOrder(as("warehouse"), orderId, { idempotencyKey: randomUUID(), lines: [{ lineId, qty }] });
    await expect(attempt(19)).rejects.toBeInstanceOf(ValidationError);
    await expect(attempt(-1)).rejects.toBeInstanceOf(ValidationError);
    await expect(attempt(0)).rejects.toBeInstanceOf(ValidationError);
    await expect(
      receivePurchaseOrder(as("warehouse"), orderId, { idempotencyKey: randomUUID(), lines: [{ lineId: randomUUID(), qty: 1 }] }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect((await product("PL-CEM-16")).onHand).toBe(48);
  });

  it("the same receipt sent five times at once is received once", async () => {
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        receivePurchaseOrder(as("warehouse"), orderId, { idempotencyKey: key, lines: [{ lineId, qty: 18 }] }),
      ),
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await product("PL-CEM-16")).toMatchObject({ onHand: 66, onOrder: 0 });
    const order = await po(orderId);
    expect(order).toMatchObject({ status: "received", unitsReceived: 48 });
    expect(order.receipts.map((r) => r.units).sort((a, b) => a - b)).toEqual([18, 30]);
    await expect(cancelPurchaseOrder(as("owner"), orderId)).rejects.toBeInstanceOf(StateError);
    await expect(receiveAll(orderId)).rejects.toBeInstanceOf(StateError);
    expect(await reconcileStock(as("owner"))).toEqual([]);
  });
});

describe("backorders are filled by receiving", () => {
  it("new stock goes to the oldest waiting sales order first", async () => {
    const make = async (qty: number) => {
      const quote = await createQuote(as("sales"), { customerId, lines: [{ productId: id("GD-NOZ-BR"), qty }] });
      await confirmOrder(as("sales"), quote.id);
      return quote.id;
    };
    const first = await make(30); // 20 on hand: 20 reserved, 10 short
    const second = await make(15); // nothing left: 15 short
    expect((await getOrder(as("owner"), first))!.unitsBackordered).toBe(10);
    expect((await getOrder(as("owner"), second))!.unitsBackordered).toBe(15);

    const created = await draft([["GD-NOZ-BR", 18, 4]]);
    await submitPurchaseOrder(as("purchasing"), created.id);
    const result = await receiveAll(created.id);
    expect(result).toMatchObject({ units: 18, allocatedToBackorders: 18 });
    expect(await getOrder(as("owner"), first)).toMatchObject({ unitsReserved: 30, unitsBackordered: 0 });
    expect(await getOrder(as("owner"), second)).toMatchObject({ unitsReserved: 8, unitsBackordered: 7 });
    expect(await product("GD-NOZ-BR")).toMatchObject({ onHand: 38, reserved: 38, available: 0 });
    expect(await reconcileStock(as("owner"))).toEqual([]);
  });

  it("receipts and order confirmations running together stay consistent", async () => {
    const pos = await Promise.all(Array.from({ length: 4 }, () => draft([["GD-SOIL-20", 10]])));
    await Promise.all(pos.map((p) => submitPurchaseOrder(as("purchasing"), p.id)));
    const quotes = await Promise.all(
      Array.from({ length: 6 }, () =>
        createQuote(as("sales"), { customerId, lines: [{ productId: id("GD-SOIL-20"), qty: 40 }] }),
      ),
    );
    await Promise.all([...pos.map((p) => receiveAll(p.id)), ...quotes.map((q) => confirmOrder(as("sales"), q.id))]);
    const soil = await product("GD-SOIL-20");
    expect(soil.onHand).toBe(125);
    expect(soil.reserved).toBeLessThanOrEqual(125);
    expect(await reconcileStock(as("owner"))).toEqual([]);
    const lines = await owner.query(
      `select 1 from sales_order_lines l
       where l.org_id = $1 and l.qty_reserved <> coalesce((select sum(r.qty) from stock_reservations r
         where r.source_id = l.id and r.status = 'open'), 0)`,
      [orgId],
    );
    expect(lines.rowCount).toBe(0);
  });
});

describe("rules and access", () => {
  it("rejects bad input", async () => {
    const make = (lines: { productId: string; qty: number; unitCost?: number }[], extra = {}) =>
      createPurchaseOrder(as("purchasing"), { supplierId, lines, ...extra });
    await expect(make([])).rejects.toBeInstanceOf(ValidationError);
    await expect(make([{ productId: id("GL-WK-L"), qty: 0 }])).rejects.toBeInstanceOf(ValidationError);
    await expect(make([{ productId: id("GL-WK-L"), qty: 1, unitCost: -2 }])).rejects.toBeInstanceOf(ValidationError);
    await expect(make([{ productId: id("GL-WK-L"), qty: 1 }], { expectedOn: "next week" })).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createPurchaseOrder(as("purchasing"), { supplierId: otherSupplier, lines: [{ productId: id("GL-WK-L"), qty: 1 }] }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("limits who may create and receive, and hides cost from roles without it", async () => {
    const lines = [{ productId: id("GL-WK-L"), qty: 10 }];
    for (const role of ["sales", "warehouse", "viewer"] as const) {
      await expect(createPurchaseOrder(as(role), { supplierId, lines })).rejects.toBeInstanceOf(ForbiddenError);
    }
    await expect(listPurchaseOrders(as("sales"))).rejects.toBeInstanceOf(ForbiddenError);
    const created = await createPurchaseOrder(as("purchasing"), { supplierId, lines, expectedOn: "2026-10-20" });
    await submitPurchaseOrder(as("purchasing"), created.id);
    await expect(receiveAll(created.id, "viewer")).rejects.toBeInstanceOf(ForbiddenError);
    const seen = (await getPurchaseOrder(as("warehouse"), created.id))!;
    expect(seen).toMatchObject({ total: null, expectedOn: "2026-10-20" });
    expect(seen.lines[0]).toMatchObject({ unitCost: null, amount: null, qty: 10 });
    expect((await listPurchaseOrders(as("warehouse"))).every((o) => o.total === null)).toBe(true);
    await receiveAll(created.id, "warehouse");
    expect((await po(created.id)).status).toBe("received");
  });

  it("cannot see or act on another company's purchase order", async () => {
    expect(await getPurchaseOrder(as("owner"), otherPo)).toBeNull();
    await expect(
      receivePurchaseOrder(as("owner"), otherPo, { idempotencyKey: randomUUID(), lines: [{ lineId: randomUUID(), qty: 1 }] }),
    ).rejects.toBeInstanceOf(StateError);
    await expect(cancelPurchaseOrder(as("owner"), otherPo)).rejects.toBeInstanceOf(StateError);
    expect((await listPurchaseOrders(as("owner"))).some((o) => o.id === otherPo)).toBe(false);
  });

  it("feeds the Home count", async () => {
    const open = await listPurchaseOrders(as("owner"), { status: "open" });
    expect((await overview(as("owner"))).openPurchaseOrders).toBe(open.length);
  });
});
