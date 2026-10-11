import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appUrl, createPool, migrate, ownerUrl, seed, type Pool } from "@bos/db";
import {
  approvePurchaseOrder, confirmOrder, countSheet, createPurchaseOrder, createQuote, ForbiddenError, getProduct, getPurchaseOrder,
  listCustomers, listMovements, listProducts, listSuppliers, markPutAway, pickQueue, putawayList, receivePurchaseOrder, reconcileStock,
  shipOrder, StockInputError, submitCount, submitPurchaseOrder, type Ctx, type Role,
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

/** A product with plenty of free stock and nothing reserved. */
async function freeProducts() {
  return (await listProducts(as("owner"))).filter((p) => p.available >= 5 && p.reserved === 0);
}

describe("picking", () => {
  it("lists a confirmed order's reserved lines in shelf order and drops it once shipped", async () => {
    const [a, b] = await freeProducts();
    await owner.query("update products set shelf_location = 'B-02' where id = $1", [a!.id]);
    await owner.query("update products set shelf_location = 'A-01' where id = $1", [b!.id]);
    const customer = (await listCustomers(as("owner")))[0]!;
    const quote = await createQuote(as("sales"), { customerId: customer.id, lines: [{ productId: a!.id, qty: 2 }, { productId: b!.id, qty: 3 }] });
    expect((await pickQueue(as("warehouse"))).some((o) => o.id === quote.id)).toBe(false); // a quote is not picked
    await confirmOrder(as("sales"), quote.id);
    const order = (await pickQueue(as("warehouse"))).find((o) => o.id === quote.id)!;
    expect(order.units).toBe(5);
    expect(order.lines.map((l) => [l.shelf, l.qty])).toEqual([["A-01", 3], ["B-02", 2]]);
    await shipOrder(as("warehouse"), quote.id, { idempotencyKey: randomUUID() });
    expect((await pickQueue(as("warehouse"))).some((o) => o.id === quote.id)).toBe(false);
  });

  it("is refused when picking or stock is switched off", async () => {
    await expect(pickQueue(as("warehouse", { picking: false }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(pickQueue(as("warehouse", { stock: false }))).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("putaway", () => {
  it("lists a delivery until each line is ticked, and records a new shelf", async () => {
    const product = (await listProducts(as("owner")))[0]!;
    const supplier = (await listSuppliers(as("owner")))[0]!;
    const { id } = await createPurchaseOrder(as("purchasing"), { supplierId: supplier.id, lines: [{ productId: product.id, qty: 4, unitCost: 1 }] });
    const { status } = await submitPurchaseOrder(as("purchasing"), id);
    if (status === "pending_approval") await approvePurchaseOrder(as("owner"), id);
    const line = (await getPurchaseOrder(as("owner"), id))!.lines[0]!;
    expect(await putawayList(as("warehouse"))).toHaveLength(0); // earlier deliveries count as done
    await receivePurchaseOrder(as("warehouse"), id, { idempotencyKey: randomUUID(), lines: [{ lineId: line.id, qty: 4 }] });
    const waiting = await putawayList(as("warehouse"));
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ productId: product.id, qty: 4, supplier: supplier.name });
    await expect(markPutAway(as("sales"), waiting[0]!.id)).rejects.toBeInstanceOf(ForbiddenError);
    await markPutAway(as("warehouse"), waiting[0]!.id, { shelf: "C-09" });
    await markPutAway(as("warehouse"), waiting[0]!.id, { shelf: "Z-99" }); // a second tick changes nothing
    expect(await putawayList(as("warehouse"))).toHaveLength(0);
    expect((await getProduct(as("owner"), product.id))!.shelfLocation).toBe("C-09");
  });
});

describe("stock counts", () => {
  it("adjusts only the products that differ and keeps the ledger in step", async () => {
    const [a, b] = await freeProducts();
    const result = await submitCount(as("warehouse"), {
      idempotencyKey: randomUUID(),
      note: "Aisle A",
      lines: [{ productId: a!.id, counted: a!.onHand - 2 }, { productId: b!.id, counted: b!.onHand }],
    });
    expect(result).toEqual({ counted: 2, changed: 1, replayed: false });
    expect((await getProduct(as("owner"), a!.id))!.onHand).toBe(a!.onHand - 2);
    expect((await listMovements(as("owner"), a!.id))[0]).toMatchObject({ kind: "adjustment", qtyDelta: -2, reason: "Stock count: Aisle A" });
    expect((await listMovements(as("owner"), b!.id))[0]?.reason ?? "").not.toContain("Stock count");
    expect(await reconcileStock(as("owner"))).toEqual([]);
  });

  it("applies a repeated submission once", async () => {
    const [a] = await freeProducts();
    const key = randomUUID();
    const lines = [{ productId: a!.id, counted: a!.onHand + 3 }];
    await submitCount(as("warehouse"), { idempotencyKey: key, lines });
    const again = await submitCount(as("warehouse"), { idempotencyKey: key, lines: [{ productId: a!.id, counted: a!.onHand + 6 }] });
    expect(again.replayed).toBe(true);
    expect((await getProduct(as("owner"), a!.id))!.onHand).toBe(a!.onHand + 3);
  });

  it("refuses a count below what is reserved, and changes nothing else in that count", async () => {
    const [a, b] = await freeProducts();
    const customer = (await listCustomers(as("owner")))[0]!;
    const quote = await createQuote(as("sales"), { customerId: customer.id, lines: [{ productId: a!.id, qty: 4 }] });
    await confirmOrder(as("sales"), quote.id);
    await expect(
      submitCount(as("warehouse"), { idempotencyKey: randomUUID(), lines: [{ productId: b!.id, counted: b!.onHand + 1 }, { productId: a!.id, counted: 1 }] }),
    ).rejects.toThrow(/reserved for orders/);
    expect((await getProduct(as("owner"), b!.id))!.onHand).toBe(b!.onHand);
  });

  it("rejects bad input and roles that cannot adjust stock", async () => {
    const [a] = await freeProducts();
    await expect(submitCount(as("warehouse"), { idempotencyKey: randomUUID(), lines: [{ productId: a!.id, counted: -1 }] })).rejects.toBeInstanceOf(StockInputError);
    await expect(submitCount(as("sales"), { idempotencyKey: randomUUID(), lines: [{ productId: a!.id, counted: 1 }] })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(countSheet(as("warehouse", { counts: false }))).rejects.toBeInstanceOf(ForbiddenError);
    expect((await countSheet(as("warehouse"), { shelfPrefix: "%" })).length).toBeGreaterThan(0); // wildcards are not honoured
  });
});
