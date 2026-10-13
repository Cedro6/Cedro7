import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appUrl, createPool, migrate, ownerUrl, seed, type Pool } from "@bos/db";
import {
  analysis, confirmOrder, createQuote, createReturn, customerStatement, ForbiddenError, listRefunds, raiseCredit, refundCredit, resolveRange, today, getProduct, listCustomers, listInvoices, listProducts, listReturnable, listReturns, reconcileStock, recordPayment,
  shipOrder, StateError, ValidationError, type Ctx, type Role,
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

/** A shipped order of 5 units at $20 with 10% tax, invoiced at $110. */
async function shipped(qty = 5) {
  const product = (await listProducts(as("owner"))).find((p) => p.available >= 40)!;
  const customer = (await listCustomers(as("owner")))[0]!;
  const order = await createQuote(as("sales"), { customerId: customer.id, taxRatePercent: 10, lines: [{ productId: product.id, qty, unitPrice: 20 }] });
  await confirmOrder(as("sales"), order.id);
  await shipOrder(as("warehouse"), order.id, { idempotencyKey: randomUUID() });
  const line = (await listReturnable(as("owner"), order.id))[0]!;
  const invoice = (await listInvoices(as("owner"), { orderId: order.id }))[0]!;
  return { order, product, customer, line, invoice };
}
const onHand = async (id: string) => (await getProduct(as("owner"), id))!.onHand;

describe("customer returns", () => {
  it("takes goods back onto the shelf and credits the unpaid invoice", async () => {
    const { order, product, line, invoice } = await shipped();
    const before = await onHand(product.id);
    expect(line).toMatchObject({ shipped: 5, returned: 0, left: 5 });
    const done = await createReturn(as("owner"), order.id, { lines: [{ orderLineId: line.orderLineId, qty: 2 }], reason: "Wrong size", restock: true, credit: true, idempotencyKey: randomUUID() });
    expect(done).toMatchObject({ units: 2, value: 40, restocked: true, creditAmount: 44, replayed: false });
    expect(done.number).toMatch(/^RET-\d{6}$/);
    expect(await onHand(product.id)).toBe(before + 2);
    expect(await reconcileStock(as("owner"))).toEqual([]);
    expect((await listReturnable(as("owner"), order.id))[0]).toMatchObject({ returned: 2, left: 3 });
    const after = (await listInvoices(as("owner"), { orderId: order.id }))[0]!;
    expect(invoice.balance - after.balance).toBeCloseTo(44, 2);
    const [listed] = await listReturns(as("owner"), order.id);
    expect(listed).toMatchObject({ number: done.number, reason: "Wrong size", restocked: true, creditNoteNumber: done.creditNoteNumber, creditAmount: 44, value: 40 });
    expect(listed!.lines).toHaveLength(1);
    expect(listed!.lines[0]).toMatchObject({ qty: 2, unitPrice: 20 });
    const move = await owner.query("select kind, qty_delta::float8 as q, source_type from stock_movements where source_id = $1", [done.id]);
    expect(move.rows).toEqual([{ kind: "return_in", q: 2, source_type: "return" }]);
  });

  it("never takes back more than was shipped, across several returns", async () => {
    const { order, line } = await shipped(3);
    const ret = (qty: number) => createReturn(as("owner"), order.id, { lines: [{ orderLineId: line.orderLineId, qty }], reason: "Damaged", restock: false, credit: false, idempotencyKey: randomUUID() });
    await expect(ret(4)).rejects.toThrow("Only 3");
    await ret(2);
    await expect(ret(2)).rejects.toThrow("Only 1");
    await ret(1);
    await expect(ret(1)).rejects.toThrow("Nothing more");
    expect(await listReturns(as("owner"), order.id)).toHaveLength(2);
  });

  it("leaves damaged goods off the shelf, and puts credit on account when the invoice is already paid", async () => {
    const { order, product, line, invoice } = await shipped();
    await recordPayment(as("owner"), invoice.id, { amount: invoice.balance, method: "Check", idempotencyKey: randomUUID() });
    const before = await onHand(product.id);
    const done = await createReturn(as("owner"), order.id, { lines: [{ orderLineId: line.orderLineId, qty: 1 }], reason: "Arrived broken", restock: false, credit: true, idempotencyKey: randomUUID() });
    expect(done.restocked).toBe(false);
    expect(await onHand(product.id)).toBe(before);
    expect(done.creditAmount).toBe(22);
    const onAccount = await owner.query<{ left: number }>(
      `select (cn.amount - coalesce((select sum(a.amount) from credit_applications a where a.credit_note_id = cn.id), 0))::float8 as left
         from credit_notes cn where cn.number = $1`, [done.creditNoteNumber]);
    expect(onAccount.rows[0]!.left).toBe(22);
  });

  it("does nothing the second time the same request arrives", async () => {
    const { order, product, line } = await shipped();
    const key = randomUUID();
    const input = { lines: [{ orderLineId: line.orderLineId, qty: 1 }], reason: "Changed mind", restock: true, credit: true, idempotencyKey: key };
    const first = await createReturn(as("owner"), order.id, input);
    const stock = await onHand(product.id);
    const second = await createReturn(as("owner"), order.id, input);
    expect(second).toMatchObject({ id: first.id, number: first.number, replayed: true, creditNoteNumber: first.creditNoteNumber });
    expect(await onHand(product.id)).toBe(stock);
    expect(await listReturns(as("owner"), order.id)).toHaveLength(1);
  });

  it("refuses bad input and lines from another order", async () => {
    const { order, line } = await shipped();
    const other = await shipped();
    const base = { reason: "x", restock: true, credit: false };
    const go = (over: object) => createReturn(as("owner"), order.id, { ...base, lines: [{ orderLineId: line.orderLineId, qty: 1 }], idempotencyKey: randomUUID(), ...over });
    await expect(go({ reason: " " })).rejects.toBeInstanceOf(ValidationError);
    await expect(go({ lines: [] })).rejects.toBeInstanceOf(ValidationError);
    await expect(go({ lines: [{ orderLineId: line.orderLineId, qty: 0 }] })).rejects.toBeInstanceOf(ValidationError);
    await expect(go({ lines: [{ orderLineId: line.orderLineId, qty: -1 }] })).rejects.toBeInstanceOf(ValidationError);
    await expect(go({ lines: [{ orderLineId: line.orderLineId, qty: 0.00001 }] })).rejects.toBeInstanceOf(ValidationError);
    await expect(go({ lines: [{ orderLineId: other.line.orderLineId, qty: 1 }] })).rejects.toThrow("not on this order");
    await expect(go({ lines: [{ orderLineId: line.orderLineId, qty: 1 }, { orderLineId: line.orderLineId, qty: 1 }] })).rejects.toBeInstanceOf(ValidationError);
    await expect(createReturn(as("owner"), randomUUID(), { ...base, lines: [{ orderLineId: line.orderLineId, qty: 1 }], idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(StateError);
    // An order that has not shipped has nothing to return.
    const product = (await listProducts(as("owner"))).find((p) => p.available >= 5)!;
    const quote = await createQuote(as("sales"), { customerId: (await listCustomers(as("owner")))[0]!.id, lines: [{ productId: product.id, qty: 1, unitPrice: 5 }] });
    const quoteLine = (await listReturnable(as("owner"), quote.id))[0]!;
    await expect(createReturn(as("owner"), quote.id, { ...base, lines: [{ orderLineId: quoteLine.orderLineId, qty: 1 }], idempotencyKey: randomUUID() })).rejects.toThrow("Nothing more");
  });

  it("respects roles and the feature switches", async () => {
    const { order, product, line } = await shipped();
    const input = () => ({ lines: [{ orderLineId: line.orderLineId, qty: 1 }], reason: "Role check", restock: true, credit: false, idempotencyKey: randomUUID() });
    await expect(createReturn(as("warehouse"), order.id, input())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createReturn(as("viewer"), order.id, input())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createReturn(as("owner", { returns: false }), order.id, input())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listReturns(as("owner", { returns: false }), order.id)).rejects.toBeInstanceOf(ForbiddenError);
    // Sales can take a return but cannot raise a credit note.
    await expect(createReturn(as("sales"), order.id, { ...input(), credit: true })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await createReturn(as("sales"), order.id, input())).creditNoteNumber).toBeNull();
    // With stock switched off the goods are recorded as back but nothing is restocked.
    const before = await onHand(product.id);
    expect((await createReturn(as("owner", { stock: false }), order.id, input())).restocked).toBe(false);
    expect(await onHand(product.id)).toBe(before);
  });

  it("keeps one company's returns away from another", async () => {
    const { order, line } = await shipped();
    const other = await owner.query<{ id: string }>("insert into organizations (name, slug) values ('Other', 'other-returns') returning id");
    const there: Ctx = { pool: app, orgId: other.rows[0]!.id, userId, role: "owner" };
    expect(await listReturnable(there, order.id)).toEqual([]);
    await expect(createReturn(there, order.id, { lines: [{ orderLineId: line.orderLineId, qty: 1 }], reason: "x", restock: true, credit: false, idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(StateError);
  });
});

describe("refunds", () => {
  it("pays back credit on the account, never more than there is, and only once per request", async () => {
    const { order, customer, line, invoice } = await shipped();
    await recordPayment(as("owner"), invoice.id, { amount: invoice.balance, method: "Check", idempotencyKey: randomUUID() });
    const start = (await customerStatement(as("owner"), customer.id))!.credit;
    await createReturn(as("owner"), order.id, { lines: [{ orderLineId: line.orderLineId, qty: 2 }], reason: "Changed mind", restock: true, credit: true, idempotencyKey: randomUUID() });
    expect((await customerStatement(as("owner"), customer.id))!.credit - start).toBeCloseTo(44, 2);
    const credit = (await customerStatement(as("owner"), customer.id))!.credit;
    await expect(refundCredit(as("owner"), customer.id, { amount: credit + 0.01, method: "Check", idempotencyKey: randomUUID() })).rejects.toThrow(/only has/);
    await expect(refundCredit(as("owner"), customer.id, { amount: 0, method: "Check", idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(ValidationError);
    await expect(refundCredit(as("owner"), customer.id, { amount: 10, method: " ", idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(ValidationError);
    const key = randomUUID();
    const done = await refundCredit(as("owner"), customer.id, { amount: 30, method: "Bank transfer", reference: "REF-1", idempotencyKey: key });
    expect(done).toMatchObject({ refunded: 30, replayed: false });
    expect(done.creditLeft).toBeCloseTo(credit - 30, 2);
    const again = await refundCredit(as("owner"), customer.id, { amount: 30, method: "Bank transfer", idempotencyKey: key });
    expect(again).toMatchObject({ refunded: 30, replayed: true });
    expect((await customerStatement(as("owner"), customer.id))!.credit).toBeCloseTo(credit - 30, 2);
    expect((await listRefunds(as("owner"), customer.id))[0]).toMatchObject({ amount: 30, method: "Bank transfer", reference: "REF-1" });
    // The rest can be refunded, and then there is nothing left to refund or to use on an invoice.
    await refundCredit(as("owner"), customer.id, { amount: Math.round((credit - 30) * 100) / 100, method: "Cash", idempotencyKey: randomUUID() });
    expect((await customerStatement(as("owner"), customer.id))!.credit).toBe(0);
    await expect(refundCredit(as("owner"), customer.id, { amount: 1, method: "Cash", idempotencyKey: randomUUID() })).rejects.toThrow(/no credit/);
  });

  it("is for roles that handle invoices, and stays inside the company", async () => {
    const customer = (await listCustomers(as("owner")))[0]!;
    await expect(refundCredit(as("sales"), customer.id, { amount: 1, method: "Cash", idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(ForbiddenError);
    const other = await owner.query<{ id: string }>("insert into organizations (name, slug) values ('Other', 'other-refunds') returning id");
    const there: Ctx = { pool: app, orgId: other.rows[0]!.id, userId, role: "owner" };
    await expect(refundCredit(there, customer.id, { amount: 1, method: "Cash", idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(ValidationError);
    expect(await listRefunds(there, customer.id)).toEqual([]);
  });
});

describe("returns and refunds in the report", () => {
  it("takes returns off sales and margin: the margin for restocked goods, the whole sale for damaged ones", async () => {
    const range = resolveRange("30d", today());
    const { order, line, product } = await shipped(6);
    const cost = (await owner.query<{ c: number }>("select unit_cost::float8 as c from sales_order_lines where id = $1", [line.orderLineId])).rows[0]!.c;
    const before = await analysis(as("owner"), { range });
    await createReturn(as("owner"), order.id, { lines: [{ orderLineId: line.orderLineId, qty: 2 }], reason: "Fine, restocked", restock: true, credit: false, idempotencyKey: randomUUID() });
    const restocked = await analysis(as("owner"), { range });
    expect(restocked.sales.returns.now - before.sales.returns.now).toBeCloseTo(40, 2);
    expect(restocked.sales.revenue.now).toBeCloseTo(before.sales.revenue.now, 2);
    expect(before.sales.net.now - restocked.sales.net.now).toBeCloseTo(40, 2);
    expect(before.sales.margin!.now - restocked.sales.margin!.now).toBeCloseTo(2 * (20 - cost), 2);
    await createReturn(as("owner"), order.id, { lines: [{ orderLineId: line.orderLineId, qty: 1 }], reason: "Broken", restock: false, credit: false, idempotencyKey: randomUUID() });
    const damaged = await analysis(as("owner"), { range });
    expect(restocked.sales.margin!.now - damaged.sales.margin!.now).toBeCloseTo(20, 2);
    expect(restocked.costs!.profit!.now - damaged.costs!.profit!.now).toBeCloseTo(20, 2);
    expect(damaged.sales.net.now).toBeCloseTo(damaged.sales.revenue.now - damaged.sales.returns.now, 2);
    expect(product.id).toBeTruthy();
    // A return made last period shows in the comparison, not in this period.
    await owner.query("update returns set returned_at = now() - interval '45 days' where order_id = $1 and reason = 'Broken'", [order.id]);
    const moved = await analysis(as("owner"), { range });
    expect(damaged.sales.returns.now - moved.sales.returns.now).toBeCloseTo(20, 2);
    expect(moved.sales.returns.was! - damaged.sales.returns.was!).toBeCloseTo(20, 2);
  });

  it("shows refunds paid in the period", async () => {
    const range = resolveRange("30d", today());
    const { order, customer, line } = await shipped();
    const before = await analysis(as("owner"), { range });
    await createReturn(as("owner"), order.id, { lines: [{ orderLineId: line.orderLineId, qty: 1 }], reason: "Refund me", restock: true, credit: false, idempotencyKey: randomUUID() });
    await raiseCredit(as("owner"), { customerId: customer.id, amount: 15, reason: "Goodwill" });
    await refundCredit(as("owner"), customer.id, { amount: 15, method: "Cash", idempotencyKey: randomUUID() });
    expect((await analysis(as("owner"), { range })).money.refunded.now - before.money.refunded.now).toBe(15);
  });
});
