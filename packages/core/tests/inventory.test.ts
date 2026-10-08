import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appUrl, createPool, migrate, ownerUrl, seed, type Pool } from "@bos/db";
import {
  adjustStock,
  ForbiddenError,
  getProduct,
  InsufficientStockError,
  listMovements,
  listProducts,
  reconcileStock,
  releaseReservation,
  reserveStock,
  StockInputError,
  type Ctx,
  type Role,
} from "../src/index";

let owner: Pool;
let app: Pool;
let orgId: string;
let userId: string;
let otherProductId: string;
const sku = new Map<string, string>();

const as = (role: Role): Ctx => ({ pool: app, orgId, userId, role });
const id = (code: string): string => sku.get(code)!;
const stock = async (code: string) => (await getProduct(as("owner"), id(code)))!;
const order = () => ({ type: "test_order", id: randomUUID() });

beforeAll(async () => {
  owner = createPool(ownerUrl());
  app = createPool(appUrl());
  app.options.max = 20;
  await owner.query("drop schema public cascade; create schema public;");
  await migrate(owner);
  ({ orgId, userId } = await seed(owner));
  for (const product of await listProducts(as("owner"))) sku.set(product.sku, product.id);
  const other = await owner.query<{ id: string }>(
    "insert into organizations (name, slug) values ('Other Co', 'other-co') returning id",
  );
  const product = await owner.query<{ id: string }>(
    "insert into products (org_id, sku, name) values ($1, 'X-1', 'Secret Product') returning id",
    [other.rows[0]!.id],
  );
  otherProductId = product.rows[0]!.id;
});

afterAll(async () => {
  await owner.end();
  await app.end();
});

describe("opening stock", () => {
  it("is posted through the ledger and reconciles", async () => {
    expect(await stock("FS-DS3-100")).toMatchObject({ onHand: 212, reserved: 0, available: 212 });
    expect(await reconcileStock(as("owner"))).toEqual([]);
    const history = await listMovements(as("owner"), id("FS-DS3-100"));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ kind: "opening_balance", qtyDelta: 212, postedBy: "Amara Okafor" });
  });

  it("is not doubled when the seed runs again", async () => {
    await seed(owner);
    expect((await stock("FS-DS3-100")).onHand).toBe(212);
    expect(await reconcileStock(as("owner"))).toEqual([]);
  });
});

describe("adjustments", () => {
  it("change on-hand, add a ledger entry and write an audit entry", async () => {
    await adjustStock(as("warehouse"), {
      productId: id("TL-UKB-50"),
      qtyDelta: -4,
      reason: "Damaged in receiving",
      idempotencyKey: randomUUID(),
    });
    expect((await stock("TL-UKB-50")).onHand).toBe(60);
    const history = await listMovements(as("owner"), id("TL-UKB-50"));
    expect(history[0]).toMatchObject({ kind: "adjustment", qtyDelta: -4, reason: "Damaged in receiving" });
    const audit = await owner.query("select count(*)::int as n from audit_log where action = 'stock.adjusted'");
    expect(audit.rows[0].n).toBe(1);
  });

  it("apply once when the same request is sent again, even five times at once", async () => {
    const key = randomUUID();
    const request = { productId: id("GL-WK-L"), qtyDelta: 10, reason: "Recount", idempotencyKey: key };
    const first = await adjustStock(as("owner"), request);
    const again = await adjustStock(as("owner"), request);
    expect([first.replayed, again.replayed]).toEqual([false, true]);
    expect((await stock("GL-WK-L")).onHand).toBe(350);

    const burst = { ...request, idempotencyKey: randomUUID() };
    const results = await Promise.all(Array.from({ length: 5 }, () => adjustStock(as("owner"), burst)));
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect((await stock("GL-WK-L")).onHand).toBe(360);
    expect(await reconcileStock(as("owner"))).toEqual([]);
  });

  it("cannot take on-hand below zero, and write nothing when refused", async () => {
    const before = await listMovements(as("owner"), id("PL-CEM-16"));
    await expect(
      adjustStock(as("owner"), { productId: id("PL-CEM-16"), qtyDelta: -19, reason: "Too many", idempotencyKey: randomUUID() }),
    ).rejects.toBeInstanceOf(InsufficientStockError);
    expect((await stock("PL-CEM-16")).onHand).toBe(18);
    expect(await listMovements(as("owner"), id("PL-CEM-16"))).toHaveLength(before.length);
  });

  it("need a reason and a real quantity", async () => {
    const base = { productId: id("GL-WK-L"), idempotencyKey: randomUUID() };
    await expect(adjustStock(as("owner"), { ...base, qtyDelta: 1, reason: "  " })).rejects.toBeInstanceOf(StockInputError);
    await expect(adjustStock(as("owner"), { ...base, qtyDelta: 0, reason: "x" })).rejects.toBeInstanceOf(StockInputError);
    await expect(adjustStock(as("owner"), { ...base, qtyDelta: Number.NaN, reason: "x" })).rejects.toBeInstanceOf(StockInputError);
    await expect(adjustStock(as("owner"), { ...base, qtyDelta: 0.00001, reason: "x" })).rejects.toBeInstanceOf(StockInputError);
  });

  it("are refused for roles without the permission", async () => {
    for (const role of ["sales", "viewer"] as const) {
      await expect(
        adjustStock(as(role), { productId: id("GL-WK-L"), qtyDelta: 1, reason: "x", idempotencyKey: randomUUID() }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("cannot touch another company's product", async () => {
    await expect(
      adjustStock(as("owner"), { productId: otherProductId, qtyDelta: 5, reason: "x", idempotencyKey: randomUUID() }),
    ).rejects.toBeInstanceOf(StockInputError);
    const leaked = await owner.query("select 1 from stock_movements where product_id = $1", [otherProductId]);
    expect(leaked.rowCount).toBe(0);
  });
});

describe("reservations", () => {
  it("50 simultaneous requests for the last 10 units give exactly 10 successes", async () => {
    const product = id("GD-NOZ-BR");
    await adjustStock(as("owner"), { productId: product, qtyDelta: -10, reason: "Set up test", idempotencyKey: randomUUID() });
    expect((await stock("GD-NOZ-BR")).available).toBe(10);
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () =>
        reserveStock(as("sales"), { productId: product, qty: 1, source: order(), idempotencyKey: randomUUID() }),
      ),
    );
    const succeeded = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(succeeded).toHaveLength(10);
    expect(failed).toHaveLength(40);
    expect(failed.every((r) => r.status === "rejected" && r.reason instanceof InsufficientStockError)).toBe(true);
    expect(await stock("GD-NOZ-BR")).toMatchObject({ onHand: 10, reserved: 10, available: 0 });
    expect(await reconcileStock(as("owner"))).toEqual([]);
  });

  it("partial reservation takes what is available and no more", async () => {
    const result = await reserveStock(as("sales"), {
      productId: id("PL-CEM-16"),
      qty: 24,
      source: order(),
      idempotencyKey: randomUUID(),
      partial: true,
    });
    expect(result.reserved).toBe(18);
    expect(await stock("PL-CEM-16")).toMatchObject({ onHand: 18, reserved: 18, available: 0 });
    const none = await reserveStock(as("sales"), {
      productId: id("PL-CEM-16"),
      qty: 5,
      source: order(),
      idempotencyKey: randomUUID(),
      partial: true,
    });
    expect(none).toMatchObject({ reserved: 0, reservationId: null });
  });

  it("a repeated reservation request does not reserve twice", async () => {
    const request = { productId: id("GD-SOIL-20"), qty: 5, source: order(), idempotencyKey: randomUUID() };
    const first = await reserveStock(as("sales"), request);
    const again = await reserveStock(as("sales"), request);
    expect(again).toMatchObject({ reserved: 5, reservationId: first.reservationId, replayed: true });
    expect((await stock("GD-SOIL-20")).reserved).toBe(5);
  });

  it("reserved stock cannot be adjusted away", async () => {
    await expect(
      adjustStock(as("owner"), { productId: id("GD-SOIL-20"), qtyDelta: -81, reason: "Write-off", idempotencyKey: randomUUID() }),
    ).rejects.toBeInstanceOf(InsufficientStockError);
    expect((await stock("GD-SOIL-20")).onHand).toBe(85);
  });

  it("releasing returns stock to available, once", async () => {
    const made = await reserveStock(as("sales"), {
      productId: id("GD-HOSE-50"),
      qty: 8,
      source: order(),
      idempotencyKey: randomUUID(),
    });
    expect((await stock("GD-HOSE-50")).available).toBe(23);
    expect(await releaseReservation(as("sales"), made.reservationId!)).toEqual({ released: 8 });
    expect(await releaseReservation(as("sales"), made.reservationId!)).toEqual({ released: 0 });
    expect(await stock("GD-HOSE-50")).toMatchObject({ onHand: 31, reserved: 0, available: 31 });
  });

  it("is refused for roles without the permission", async () => {
    await expect(
      reserveStock(as("warehouse"), { productId: id("GL-WK-L"), qty: 1, source: order(), idempotencyKey: randomUUID() }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("ledger integrity", () => {
  it("balances match the ledger after 300 mixed operations run concurrently", async () => {
    const products = [id("FS-DS3-100"), id("GL-WK-L"), id("TL-UKB-50")];
    const pick = <T,>(items: T[]): T => items[Math.floor(Math.random() * items.length)]!;
    const reservations: string[] = [];
    const work = Array.from({ length: 300 }, (_, n) => async () => {
      try {
        if (n % 3 === 0) {
          const made = await reserveStock(as("sales"), {
            productId: pick(products),
            qty: 1 + Math.floor(Math.random() * 40),
            source: order(),
            idempotencyKey: randomUUID(),
            partial: n % 2 === 0,
          });
          if (made.reservationId) reservations.push(made.reservationId);
        } else if (n % 3 === 1 && reservations.length > 0) {
          await releaseReservation(as("sales"), reservations.pop()!);
        } else {
          await adjustStock(as("owner"), {
            productId: pick(products),
            qtyDelta: Math.floor(Math.random() * 120) - 70,
            reason: "Random",
            idempotencyKey: randomUUID(),
          });
        }
      } catch (error) {
        if (!(error instanceof InsufficientStockError) && !(error instanceof StockInputError)) throw error;
      }
    });
    for (let start = 0; start < work.length; start += 25) {
      await Promise.all(work.slice(start, start + 25).map((run) => run()));
    }
    expect(await reconcileStock(as("owner"))).toEqual([]);
    const negative = await owner.query("select 1 from stock_levels where on_hand < 0 or reserved < 0 or reserved > on_hand");
    expect(negative.rowCount).toBe(0);
  });

  it("the app role cannot edit or delete ledger entries", async () => {
    const attempt = (sql: string) =>
      app.connect().then(async (client) => {
        try {
          await client.query("begin");
          await client.query("select set_config('app.org_id', $1, true)", [orgId]);
          await client.query(sql);
        } finally {
          await client.query("rollback");
          client.release();
        }
      });
    await expect(attempt("update stock_movements set qty_delta = 999")).rejects.toThrow(/permission denied/);
    await expect(attempt("delete from stock_movements")).rejects.toThrow(/permission denied/);
  });

  it("the database itself refuses a negative balance", async () => {
    await expect(owner.query("update stock_levels set on_hand = -1 where org_id = $1", [orgId])).rejects.toThrow(
      /check constraint/,
    );
  });

  it("reconciliation reports a balance that was changed outside the ledger", async () => {
    await owner.query("update stock_levels set on_hand = on_hand + 7 where product_id = $1", [id("GD-HOSE-50")]);
    const mismatches = await reconcileStock(as("owner"));
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({ productId: id("GD-HOSE-50"), onHand: 38, ledgerTotal: 31 });
    await owner.query("update stock_levels set on_hand = on_hand - 7 where product_id = $1", [id("GD-HOSE-50")]);
  });
});
