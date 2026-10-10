import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appUrl, createPool, migrate, ownerUrl, seed, type Pool } from "@bos/db";
import {
  confirmOrder,
  createPriceList,
  createQuote,
  currentMembership,
  deletePriceList,
  ForbiddenError,
  getCustomer,
  getOrder,
  getProduct,
  listCustomers,
  listPriceLists,
  listProducts,
  pricesForCustomer,
  reconcileStock,
  reserveAvailable,
  setBusinessType,
  setCustomerPriceList,
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
let customerId: string;
let otherCustomer: string;
let otherOrgList: string;
const sku = new Map<string, string>();
const id = (code: string): string => sku.get(code)!;

/** The acting person as a signed-in request builds it: role plus the company's current switches. */
const as = async (role: Role): Promise<Ctx> => {
  const membership = await currentMembership(app, orgId, userId);
  return { pool: app, orgId, userId, role, features: membership!.features };
};

beforeAll(async () => {
  owner = createPool(ownerUrl());
  app = createPool(appUrl());
  await owner.query("drop schema public cascade; create schema public;");
  await migrate(owner);
  ({ orgId, userId } = await seed(owner));
  const ctx = await as("owner");
  for (const p of await listProducts(ctx)) sku.set(p.sku, p.id);
  const customers = await listCustomers(ctx);
  customerId = customers[0]!.id;
  otherCustomer = customers[1]!.id;
  const other = await owner.query<{ id: string }>("insert into organizations (name, slug) values ('Other Co', 'other-co') returning id");
  otherOrgList = (
    await owner.query<{ id: string }>("insert into price_lists (org_id, name, percent_off) values ($1, 'Secret', 50) returning id", [
      other.rows[0]!.id,
    ])
  ).rows[0]!.id;
});

afterAll(async () => {
  await owner.end();
  await app.end();
});

describe("price lists and discounts", () => {
  let listId: string;

  it("creates a price list with a percentage and a special price", async () => {
    ({ id: listId } = await createPriceList(await as("sales"), {
      name: "Contractor pricing",
      percentOff: 10,
      specialPrices: [{ productId: id("GD-HOSE-50"), price: 20 }],
    }));
    const lists = await listPriceLists(await as("sales"));
    expect(lists).toHaveLength(1);
    expect(lists[0]).toMatchObject({ name: "Contractor pricing", percentOff: 10, customers: 0 });
    expect(lists[0]!.specialPrices).toEqual([expect.objectContaining({ sku: "GD-HOSE-50", price: 20 })]);
  });

  it("refuses a bad percentage, a duplicate name, a negative price, and roles that cannot sell", async () => {
    const ctx = await as("owner");
    await expect(createPriceList(ctx, { name: "Free", percentOff: 100 })).rejects.toBeInstanceOf(ValidationError);
    await expect(createPriceList(ctx, { name: "contractor PRICING" })).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createPriceList(ctx, { name: "Neg", specialPrices: [{ productId: id("GD-HOSE-50"), price: -1 }] }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(createPriceList(await as("warehouse"), { name: "Nope" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("gives a customer on the list its prices, and everyone else the product's price", async () => {
    await setCustomerPriceList(await as("sales"), customerId, listId);
    expect((await getCustomer(await as("sales"), customerId))!.priceListName).toBe("Contractor pricing");
    const ctx = await as("sales");
    const mine = await pricesForCustomer(ctx, customerId);
    const theirs = await pricesForCustomer(ctx, otherCustomer);
    expect(mine[id("GD-HOSE-50")]).toBe(20); // special price wins over the percentage
    expect(mine[id("FS-DS3-100")]).toBe(7.65); // 8.50 less 10%
    expect(theirs[id("GD-HOSE-50")]).toBe(24);
    expect(theirs[id("FS-DS3-100")]).toBe(8.5);
  });

  it("prices a quote from the customer's list and applies a line discount on top", async () => {
    const quote = await createQuote(await as("sales"), {
      customerId,
      taxRatePercent: 10,
      lines: [
        { productId: id("FS-DS3-100"), qty: 10 },
        { productId: id("GD-HOSE-50"), qty: 2, discountPercent: 25 },
        { productId: id("GL-WK-L"), qty: 4, unitPrice: 5, discountPercent: 10 },
      ],
    });
    const order = (await getOrder(await as("sales"), quote.id))!;
    expect(order.lines.map((l) => [l.listPrice, l.discountPercent, l.unitPrice, l.amount])).toEqual([
      [7.65, 0, 7.65, 76.5],
      [20, 25, 15, 30],
      [5, 10, 4.5, 18],
    ]);
    expect(order.subtotal).toBe(124.5);
    expect(order.tax).toBe(12.45);
    expect(order.total).toBe(136.95);
  });

  it("refuses a discount outside 0 to 100 percent", async () => {
    for (const discountPercent of [-1, 101, Number.NaN]) {
      await expect(
        createQuote(await as("sales"), { customerId, lines: [{ productId: id("GL-WK-L"), qty: 1, discountPercent }] }),
      ).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it("cannot put a customer on another company's price list", async () => {
    await expect(setCustomerPriceList(await as("owner"), customerId, otherOrgList)).rejects.toBeInstanceOf(ValidationError);
    expect((await getCustomer(await as("owner"), customerId))!.priceListName).toBe("Contractor pricing");
  });

  it("deleting a list puts its customers back on list prices and leaves old orders alone", async () => {
    const before = await createQuote(await as("sales"), { customerId, lines: [{ productId: id("FS-DS3-100"), qty: 1 }] });
    expect((await deletePriceList(await as("sales"), listId)).customers).toBe(1);
    expect((await getCustomer(await as("sales"), customerId))!.priceListId).toBeNull();
    expect((await getOrder(await as("sales"), before.id))!.lines[0]!.unitPrice).toBe(7.65);
    const after = await createQuote(await as("sales"), { customerId, lines: [{ productId: id("FS-DS3-100"), qty: 1 }] });
    expect((await getOrder(await as("sales"), after.id))!.lines[0]!.unitPrice).toBe(8.5);
  });
});

describe("a business that tracks stock (Wholesale)", () => {
  it("takes a quote through confirm and ship to a finished order, moving stock", async () => {
    const before = (await getProduct(await as("owner"), id("FS-DS3-100")))!;
    const quote = await createQuote(await as("sales"), { customerId, lines: [{ productId: id("FS-DS3-100"), qty: 5 }] });
    expect((await confirmOrder(await as("sales"), quote.id)).reserved).toBe(5);
    const shipped = await shipOrder(await as("warehouse"), quote.id, { idempotencyKey: randomUUID() });
    expect(shipped.units).toBe(5);
    expect((await getOrder(await as("owner"), quote.id))!.status).toBe("shipped");
    expect((await getProduct(await as("owner"), id("FS-DS3-100")))!.onHand).toBe(before.onHand - 5);
  });

  it("still needs the warehouse to ship: a sales person cannot", async () => {
    const quote = await createQuote(await as("sales"), { customerId, lines: [{ productId: id("FS-DS3-100"), qty: 1 }] });
    await confirmOrder(await as("sales"), quote.id);
    await expect(shipOrder(await as("sales"), quote.id, { idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("a business that does not track stock (Sales)", () => {
  let reservedBefore: string;

  beforeAll(async () => {
    // An order confirmed while stock was still tracked, so it holds a reservation.
    const quote = await createQuote(await as("sales"), { customerId, lines: [{ productId: id("GL-WK-L"), qty: 3 }] });
    await confirmOrder(await as("sales"), quote.id);
    reservedBefore = quote.id;
    await setBusinessType(await as("owner"), "sales");
  });

  it("takes a quote for more than was ever in stock through confirm and complete, moving no stock", async () => {
    const product = (await getProduct(await as("owner"), id("PL-CEM-16")))!;
    const quote = await createQuote(await as("sales"), {
      customerId,
      lines: [
        { productId: id("PL-CEM-16"), qty: 5000 },
        { productId: id("TL-UKB-50"), qty: 2 },
      ],
    });
    expect((await confirmOrder(await as("sales"), quote.id)).reserved).toBe(0);
    const confirmed = (await getOrder(await as("sales"), quote.id))!;
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.unitsReserved).toBe(0);

    const key = randomUUID();
    const done = await shipOrder(await as("owner"), quote.id, { idempotencyKey: key });
    expect(done.units).toBe(5002);
    const order = (await getOrder(await as("sales"), quote.id))!;
    expect(order.status).toBe("shipped");
    expect(order.unitsShipped).toBe(5002);
    expect(order.shipments).toHaveLength(1);

    const after = (await getProduct(await as("owner"), id("PL-CEM-16")))!;
    expect(after.onHand).toBe(product.onHand);
    expect(after.reserved).toBe(product.reserved);

    // pressing the button twice does not complete it twice
    const again = await shipOrder(await as("owner"), quote.id, { idempotencyKey: key });
    expect(again.replayed).toBe(true);
    await expect(shipOrder(await as("owner"), quote.id, { idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(StateError);
  });

  it("hands back stock that was reserved before tracking was switched off", async () => {
    const before = (await getProduct(await as("owner"), id("GL-WK-L")))!;
    await shipOrder(await as("owner"), reservedBefore, { idempotencyKey: randomUUID() });
    const after = (await getProduct(await as("owner"), id("GL-WK-L")))!;
    expect(after.reserved).toBe(before.reserved - 3);
    expect(after.onHand).toBe(before.onHand);
    expect((await getOrder(await as("owner"), reservedBefore))!.status).toBe("shipped");
  });

  it("lets the sales person complete their own order, since there is no warehouse step", async () => {
    const quote = await createQuote(await as("sales"), { customerId, lines: [{ productId: id("GL-WK-L"), qty: 2 }] });
    await confirmOrder(await as("sales"), quote.id);
    const done = await shipOrder(await as("sales"), quote.id, { idempotencyKey: randomUUID() });
    expect(done.units).toBe(2);
    expect((await getOrder(await as("sales"), quote.id))!.status).toBe("shipped");
    await expect(shipOrder(await as("viewer"), quote.id, { idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("has no reserve step", async () => {
    const quote = await createQuote(await as("sales"), { customerId, lines: [{ productId: id("GL-WK-L"), qty: 1 }] });
    await confirmOrder(await as("sales"), quote.id);
    await expect(reserveAvailable(await as("sales"), quote.id)).rejects.toBeInstanceOf(StateError);
  });

  it("leaves the stock ledger consistent", async () => {
    await setBusinessType(await as("owner"), "distributor");
    expect(await reconcileStock(await as("owner"))).toEqual([]);
  });
});
