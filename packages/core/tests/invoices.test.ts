import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appUrl, createPool, migrate, ownerUrl, seed, type Pool } from "@bos/db";
import {
  confirmOrder,
  createInvoice,
  createQuote,
  customerStatement,
  ForbiddenError,
  getInvoice,
  listCustomers,
  listInvoices,
  listProducts,
  raiseCredit,
  recordPayment,
  requestDeposit,
  shipOrder,
  StateError,
  termsDays,
  useCustomerCredit,
  ValidationError,
  voidInvoice,
  type Ctx,
  type Role,
} from "../src/index";

let owner: Pool;
let app: Pool;
let orgId: string;
let userId: string;
let net30: string; // Bayside Hardware, Net 30
let onReceipt: string; // Tanaka Garden Center, Due on receipt
let otherOrgInvoice: string;
const sku = new Map<string, string>();
const id = (code: string): string => sku.get(code)!;
const as = (role: Role): Ctx => ({ pool: app, orgId, userId, role });
const pay = (invoiceId: string, amount: number, role: Role = "owner") =>
  recordPayment(as(role), invoiceId, { amount, method: "Check", idempotencyKey: randomUUID() });
const days = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / 86_400_000);

/** A confirmed order for stock that is on the shelf, so it can ship in full. */
async function order(customerId: string, lines: { code: string; qty: number; discountPercent?: number }[], taxRatePercent = 0) {
  const quote = await createQuote(as("sales"), {
    customerId,
    taxRatePercent,
    lines: lines.map((l) => ({ productId: id(l.code), qty: l.qty, discountPercent: l.discountPercent })),
  });
  await confirmOrder(as("sales"), quote.id);
  return quote.id;
}
const ship = (orderId: string) => shipOrder(as("warehouse"), orderId, { idempotencyKey: randomUUID() });
const invoicesOf = (orderId: string) => listInvoices(as("owner"), { orderId });

beforeAll(async () => {
  owner = createPool(ownerUrl());
  app = createPool(appUrl());
  app.options.max = 20;
  await owner.query("drop schema public cascade; create schema public;");
  await migrate(owner);
  ({ orgId, userId } = await seed(owner));
  for (const p of await listProducts(as("owner"))) sku.set(p.sku, p.id);
  const customers = await listCustomers(as("owner"));
  net30 = customers.find((c) => c.name === "Bayside Hardware")!.id;
  onReceipt = customers.find((c) => c.name === "Tanaka Garden Center")!.id;
  const other = await owner.query<{ id: string }>("insert into organizations (name, slug) values ('Other Co', 'other-co') returning id");
  const otherCustomer = await owner.query<{ id: string }>("insert into customers (org_id, name) values ($1, 'Secret Customer') returning id", [
    other.rows[0]!.id,
  ]);
  otherOrgInvoice = (
    await owner.query<{ id: string }>(
      `insert into invoices (org_id, number, kind, customer_id, subtotal, tax, gross, amount, due_at)
       values ($1, 'INV-000001', 'manual', $2, 100, 0, 100, 100, now()) returning id`,
      [other.rows[0]!.id, otherCustomer.rows[0]!.id],
    )
  ).rows[0]!.id;
});

afterAll(async () => {
  await owner.end();
  await app.end();
});

describe("payment terms", () => {
  it("reads the number of days out of the terms, and treats anything else as due on issue", () => {
    expect(termsDays("Net 30")).toBe(30);
    expect(termsDays("net 15")).toBe(15);
    expect(termsDays("Due on receipt")).toBe(0);
    expect(termsDays(null)).toBe(0);
  });
});

describe("an invoice for each shipment", () => {
  it("is raised when an order ships, for exactly what shipped, with discount and tax", async () => {
    const orderId = await order(net30, [{ code: "FS-DS3-100", qty: 10 }, { code: "GD-HOSE-50", qty: 2, discountPercent: 25 }], 6.25);
    const shipped = await ship(orderId);
    expect(shipped.invoice).toMatchObject({ amount: 128.56 });
    const [summary] = await invoicesOf(orderId);
    const invoice = (await getInvoice(as("sales"), summary!.id))!;
    expect(invoice).toMatchObject({ kind: "shipment", state: "unpaid", subtotal: 121, tax: 7.56, gross: 128.56, amount: 128.56, balance: 128.56 });
    expect(invoice.shipmentNumber).toBe(shipped.shipmentNumber);
    expect(invoice.lines.map((l) => [l.description, l.qty, l.listPrice, l.discountPercent, l.unitPrice, l.amount])).toEqual([
      ["Deck screws 3 in, box of 100", 10, 8.5, 0, 8.5, 85],
      ["Garden hose 50 ft, heavy duty", 2, 24, 25, 18, 36],
    ]);
    expect(days(invoice.issuedAt, invoice.dueAt)).toBe(30);
  });

  it("is due on issue for a customer with no days in their terms", async () => {
    const orderId = await order(onReceipt, [{ code: "GL-WK-L", qty: 1 }]);
    await ship(orderId);
    const [invoice] = await invoicesOf(orderId);
    expect(days(invoice!.issuedAt, invoice!.dueAt)).toBe(0);
  });

  it("raises one invoice per shipment when an order ships in parts", async () => {
    // 40 on the shelf at most are free for this line; the rest waits for more stock
    const before = (await listProducts(as("owner"))).find((p) => p.sku === "TL-UKB-50")!;
    const orderId = await order(net30, [{ code: "TL-UKB-50", qty: before.available + 5 }]);
    await ship(orderId);
    const first = await invoicesOf(orderId);
    expect(first).toHaveLength(1);
    expect(first[0]!.amount).toBe(Math.round(before.available * 11 * 100) / 100);
    // nothing more is reserved, so there is nothing to ship and no second invoice
    await expect(ship(orderId)).rejects.toBeInstanceOf(StateError);
    expect(await invoicesOf(orderId)).toHaveLength(1);
  });

  it("does not raise a second invoice when the same ship request is repeated", async () => {
    const orderId = await order(net30, [{ code: "GL-WK-L", qty: 2 }]);
    const key = randomUUID();
    await shipOrder(as("warehouse"), orderId, { idempotencyKey: key });
    await shipOrder(as("warehouse"), orderId, { idempotencyKey: key });
    expect(await invoicesOf(orderId)).toHaveLength(1);
  });
});

describe("payments", () => {
  let invoiceId: string;

  beforeAll(async () => {
    const orderId = await order(net30, [{ code: "GL-WK-L", qty: 20 }]); // 20 x 4.25 = 85.00
    await ship(orderId);
    invoiceId = (await invoicesOf(orderId))[0]!.id;
  });

  it("only someone who handles invoices can record one", async () => {
    for (const role of ["sales", "purchasing", "warehouse", "viewer"] as const) {
      await expect(pay(invoiceId, 10, role)).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("refuses zero, negative, fractions of a cent, an unknown method and more than is owed", async () => {
    for (const amount of [0, -5, 10.001, Number.NaN]) await expect(pay(invoiceId, amount)).rejects.toBeInstanceOf(ValidationError);
    await expect(
      recordPayment(as("owner"), invoiceId, { amount: 10, method: "Barter", idempotencyKey: randomUUID() }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(pay(invoiceId, 85.01)).rejects.toBeInstanceOf(ValidationError);
    expect((await getInvoice(as("owner"), invoiceId))!.payments).toHaveLength(0);
  });

  it("takes a part payment, then the rest, and then no more", async () => {
    expect((await pay(invoiceId, 30)).balance).toBe(55);
    expect((await getInvoice(as("owner"), invoiceId))!).toMatchObject({ state: "part_paid", paid: 30, balance: 55 });
    expect((await pay(invoiceId, 55)).balance).toBe(0);
    const paid = (await getInvoice(as("owner"), invoiceId))!;
    expect(paid).toMatchObject({ state: "paid", paid: 85, balance: 0 });
    expect(paid.paidAt).toBeInstanceOf(Date);
    await expect(pay(invoiceId, 0.01)).rejects.toBeInstanceOf(StateError);
  });

  it("records a repeated request once", async () => {
    const orderId = await order(net30, [{ code: "GL-WK-L", qty: 4 }]); // 17.00
    await ship(orderId);
    const other = (await invoicesOf(orderId))[0]!.id;
    const key = randomUUID();
    await recordPayment(as("owner"), other, { amount: 5, method: "Cash", idempotencyKey: key });
    const again = await recordPayment(as("owner"), other, { amount: 5, method: "Cash", idempotencyKey: key });
    expect(again.replayed).toBe(true);
    expect((await getInvoice(as("owner"), other))!.paid).toBe(5);
  });

  it("never accepts more than the balance when two payments arrive together", async () => {
    const orderId = await order(net30, [{ code: "GL-WK-L", qty: 8 }]); // 34.00
    await ship(orderId);
    const racing = (await invoicesOf(orderId))[0]!.id;
    const results = await Promise.allSettled([pay(racing, 20), pay(racing, 20), pay(racing, 20)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await getInvoice(as("owner"), racing))!).toMatchObject({ paid: 20, balance: 14 });
  });

  it("marks an invoice overdue once its due date has passed", async () => {
    const orderId = await order(onReceipt, [{ code: "GL-WK-L", qty: 1 }]);
    await ship(orderId);
    const late = (await invoicesOf(orderId))[0]!.id;
    await owner.query("update invoices set due_at = now() - interval '3 days' where id = $1", [late]);
    expect((await getInvoice(as("owner"), late))!.state).toBe("overdue");
    expect((await listInvoices(as("owner"), { state: "overdue" })).map((i) => i.id)).toContain(late);
    await pay(late, 4.25);
    expect((await getInvoice(as("owner"), late))!.state).toBe("paid");
  });
});

describe("deposits", () => {
  it("bills a share of the order up front and takes it off the invoices that follow", async () => {
    const quote = await createQuote(as("sales"), { customerId: net30, taxRatePercent: 10, lines: [{ productId: id("FS-DS3-100"), qty: 20 }] });
    // 20 x 8.50 = 170.00, plus 10% = 187.00; 30% deposit = 56.10
    const deposit = await requestDeposit(as("owner"), quote.id, 30);
    expect(deposit.amount).toBe(56.1);
    const depositInvoice = (await getInvoice(as("owner"), deposit.id))!;
    expect(depositInvoice).toMatchObject({ kind: "deposit", depositPercent: 30, amount: 56.1 });
    expect(days(depositInvoice.issuedAt, depositInvoice.dueAt)).toBe(0);

    await confirmOrder(as("sales"), quote.id);
    await ship(quote.id);
    const invoices = await invoicesOf(quote.id);
    const final = (await getInvoice(as("owner"), invoices.find((i) => i.kind === "shipment")!.id))!;
    expect(final).toMatchObject({ gross: 187, depositApplied: 56.1, amount: 130.9 });
    // the customer is billed the order total exactly once across both invoices
    expect(Math.round(invoices.reduce((sum, i) => sum + i.amount, 0) * 100) / 100).toBe(187);
  });

  it("allows one deposit per order, only before anything ships, between 1 and 99 percent, and only by someone who handles invoices", async () => {
    const quote = await createQuote(as("sales"), { customerId: net30, lines: [{ productId: id("GL-WK-L"), qty: 10 }] });
    await expect(requestDeposit(as("sales"), quote.id, 50)).rejects.toBeInstanceOf(ForbiddenError);
    for (const percent of [0, 100, -10, Number.NaN]) {
      await expect(requestDeposit(as("owner"), quote.id, percent)).rejects.toBeInstanceOf(ValidationError);
    }
    await requestDeposit(as("owner"), quote.id, 50);
    await expect(requestDeposit(as("owner"), quote.id, 10)).rejects.toBeInstanceOf(StateError);
    const shippedOrder = await order(net30, [{ code: "GL-WK-L", qty: 1 }]);
    await ship(shippedOrder);
    await expect(requestDeposit(as("owner"), shippedOrder, 10)).rejects.toBeInstanceOf(StateError);
  });

  it("never applies more deposit than an invoice is worth", async () => {
    const before = (await listProducts(as("owner"))).find((p) => p.sku === "GD-NOZ-BR")!;
    const quote = await createQuote(as("sales"), { customerId: net30, lines: [{ productId: id("GD-NOZ-BR"), qty: before.available + 100 }] });
    const total = (before.available + 100) * 7.5;
    const deposit = await requestDeposit(as("owner"), quote.id, 90);
    await confirmOrder(as("sales"), quote.id);
    await ship(quote.id); // only what is on the shelf ships
    const first = (await invoicesOf(quote.id)).find((i) => i.kind === "shipment")!;
    const detail = (await getInvoice(as("owner"), first.id))!;
    expect(detail.depositApplied).toBe(detail.gross);
    expect(detail.amount).toBe(0);
    expect(detail.state).toBe("paid");
    expect(detail.gross).toBeLessThan(deposit.amount);
    expect(deposit.amount).toBe(Math.round(total * 90) / 100);
  });
});

describe("invoices written by hand", () => {
  it("adds up lines and tax, and is due by the customer's terms unless told otherwise", async () => {
    const made = await createInvoice(as("owner"), {
      customerId: net30,
      taxRatePercent: 8,
      lines: [
        { description: "Delivery and setup", qty: 1, unitPrice: 75 },
        { description: "Extra labour, hours", qty: 2.5, unitPrice: 40 },
      ],
    });
    const invoice = (await getInvoice(as("owner"), made.id))!;
    expect(invoice).toMatchObject({ kind: "manual", subtotal: 175, tax: 14, amount: 189, orderId: null });
    expect(days(invoice.issuedAt, invoice.dueAt)).toBe(30);
    const sooner = await createInvoice(as("owner"), { customerId: net30, dueInDays: 7, lines: [{ description: "Rush fee", qty: 1, unitPrice: 20 }] });
    const detail = (await getInvoice(as("owner"), sooner.id))!;
    expect(days(detail.issuedAt, detail.dueAt)).toBe(7);
  });

  it("needs a customer, at least one described line, sensible numbers, and the right role", async () => {
    const line = { description: "Thing", qty: 1, unitPrice: 1 };
    await expect(createInvoice(as("sales"), { customerId: net30, lines: [line] })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createInvoice(as("owner"), { customerId: randomUUID(), lines: [line] })).rejects.toBeInstanceOf(ValidationError);
    await expect(createInvoice(as("owner"), { customerId: net30, lines: [] })).rejects.toBeInstanceOf(ValidationError);
    await expect(createInvoice(as("owner"), { customerId: net30, lines: [{ ...line, description: " " }] })).rejects.toBeInstanceOf(ValidationError);
    await expect(createInvoice(as("owner"), { customerId: net30, lines: [{ ...line, qty: 0 }] })).rejects.toBeInstanceOf(ValidationError);
    await expect(createInvoice(as("owner"), { customerId: net30, lines: [{ ...line, unitPrice: -1 }] })).rejects.toBeInstanceOf(ValidationError);
    await expect(createInvoice(as("owner"), { customerId: net30, lines: [line], taxRatePercent: 100 })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("voiding", () => {
  it("voids a hand-written invoice that nothing has been received against, and takes it off what is owed", async () => {
    const made = await createInvoice(as("owner"), { customerId: onReceipt, lines: [{ description: "Mistake", qty: 1, unitPrice: 50 }] });
    const owedBefore = (await customerStatement(as("owner"), onReceipt))!.owed;
    await expect(voidInvoice(as("owner"), made.id, " ")).rejects.toBeInstanceOf(ValidationError);
    await expect(voidInvoice(as("sales"), made.id, "Wrong customer")).rejects.toBeInstanceOf(ForbiddenError);
    await voidInvoice(as("owner"), made.id, "Wrong customer");
    expect((await getInvoice(as("owner"), made.id))!).toMatchObject({ state: "void", balance: 0, voidReason: "Wrong customer" });
    expect((await customerStatement(as("owner"), onReceipt))!.owed).toBe(Math.round((owedBefore - 50) * 100) / 100);
    await expect(voidInvoice(as("owner"), made.id, "Again")).rejects.toBeInstanceOf(StateError);
    await expect(pay(made.id, 10)).rejects.toBeInstanceOf(StateError);
  });

  it("refuses to void an order's invoice, or one with money received", async () => {
    const orderId = await order(net30, [{ code: "GL-WK-L", qty: 1 }]);
    await ship(orderId);
    await expect(voidInvoice(as("owner"), (await invoicesOf(orderId))[0]!.id, "No")).rejects.toBeInstanceOf(StateError);
    const made = await createInvoice(as("owner"), { customerId: net30, lines: [{ description: "Part paid", qty: 1, unitPrice: 50 }] });
    await pay(made.id, 10);
    await expect(voidInvoice(as("owner"), made.id, "No")).rejects.toBeInstanceOf(StateError);
  });
});

describe("credit notes", () => {
  it("reduces the invoice it is raised against and keeps any excess on the customer's account", async () => {
    const made = await createInvoice(as("owner"), { customerId: onReceipt, lines: [{ description: "Service", qty: 1, unitPrice: 60 }] });
    const before = (await customerStatement(as("owner"), onReceipt))!.credit;
    const credit = await raiseCredit(as("owner"), { invoiceId: made.id, amount: 100, reason: "Goodwill" });
    expect(credit).toMatchObject({ applied: 60, onAccount: 40 });
    const invoice = (await getInvoice(as("owner"), made.id))!;
    expect(invoice).toMatchObject({ state: "paid", credited: 60, balance: 0 });
    expect(invoice.credits).toEqual([expect.objectContaining({ number: credit.number, amount: 60, reason: "Goodwill" })]);
    expect((await customerStatement(as("owner"), onReceipt))!.credit).toBe(before + 40);
  });

  it("uses credit on the account against a later invoice, oldest first, and never more than is owed", async () => {
    const available = (await customerStatement(as("owner"), onReceipt))!.credit;
    expect(available).toBeGreaterThanOrEqual(40);
    const small = await createInvoice(as("owner"), { customerId: onReceipt, lines: [{ description: "Small", qty: 1, unitPrice: 15 }] });
    expect(await useCustomerCredit(as("owner"), small.id)).toEqual({ applied: 15, balance: 0 });
    expect((await customerStatement(as("owner"), onReceipt))!.credit).toBe(available - 15);
    await expect(useCustomerCredit(as("owner"), small.id)).rejects.toBeInstanceOf(StateError);

    const big = await createInvoice(as("owner"), { customerId: onReceipt, lines: [{ description: "Big", qty: 1, unitPrice: 500 }] });
    const used = await useCustomerCredit(as("owner"), big.id);
    expect(used).toEqual({ applied: available - 15, balance: 500 - (available - 15) });
    expect((await customerStatement(as("owner"), onReceipt))!.credit).toBe(0);
    await expect(useCustomerCredit(as("owner"), big.id)).rejects.toBeInstanceOf(StateError);
  });

  it("can be raised for a customer with no invoice, and needs an amount, a reason and the right role", async () => {
    const credit = await raiseCredit(as("owner"), { customerId: net30, amount: 25, reason: "Damaged in transit" });
    expect(credit).toMatchObject({ applied: 0, onAccount: 25 });
    await expect(raiseCredit(as("sales"), { customerId: net30, amount: 5, reason: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(raiseCredit(as("owner"), { customerId: net30, amount: 0, reason: "x" })).rejects.toBeInstanceOf(ValidationError);
    await expect(raiseCredit(as("owner"), { customerId: net30, amount: 5, reason: " " })).rejects.toBeInstanceOf(ValidationError);
    await expect(raiseCredit(as("owner"), { amount: 5, reason: "x" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("does not let two uses of the same credit both succeed", async () => {
    await raiseCredit(as("owner"), { customerId: onReceipt, amount: 30, reason: "Race" });
    const a = await createInvoice(as("owner"), { customerId: onReceipt, lines: [{ description: "A", qty: 1, unitPrice: 30 }] });
    const b = await createInvoice(as("owner"), { customerId: onReceipt, lines: [{ description: "B", qty: 1, unitPrice: 30 }] });
    const results = await Promise.allSettled([useCustomerCredit(as("owner"), a.id), useCustomerCredit(as("owner"), b.id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await customerStatement(as("owner"), onReceipt))!.credit).toBe(0);
  });
});

describe("statements and lists", () => {
  it("adds up what a customer owes from their invoices, leaving out void ones", async () => {
    const statement = (await customerStatement(as("sales"), net30))!;
    expect(statement.invoices.every((i) => i.state !== "void")).toBe(true);
    const sum = Math.round(statement.invoices.reduce((s, i) => s + i.balance, 0) * 100) / 100;
    expect(statement.owed).toBe(sum);
    expect(statement.credit).toBe(25);
  });

  it("the open list is exactly the invoices with a balance", async () => {
    const open = await listInvoices(as("owner"), { state: "open" });
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((i) => i.balance > 0 && i.state !== "void" && i.state !== "paid")).toBe(true);
  });

  it("the books balance: every invoice's amount equals what was paid, credited and is still owed", async () => {
    for (const invoice of await listInvoices(as("owner"))) {
      if (invoice.state === "void") continue;
      expect(Math.round((invoice.paid + invoice.credited + invoice.balance) * 100) / 100).toBe(invoice.amount);
    }
  });
});

describe("company separation", () => {
  it("cannot see, pay, credit or void another company's invoice", async () => {
    expect(await getInvoice(as("owner"), otherOrgInvoice)).toBeNull();
    expect((await listInvoices(as("owner"))).map((i) => i.id)).not.toContain(otherOrgInvoice);
    await expect(pay(otherOrgInvoice, 10)).rejects.toBeInstanceOf(StateError);
    await expect(raiseCredit(as("owner"), { invoiceId: otherOrgInvoice, amount: 10, reason: "x" })).rejects.toBeInstanceOf(StateError);
    await expect(useCustomerCredit(as("owner"), otherOrgInvoice)).rejects.toBeInstanceOf(StateError);
    await expect(voidInvoice(as("owner"), otherOrgInvoice, "x")).rejects.toBeInstanceOf(StateError);
    const untouched = await owner.query("select 1 from payments where invoice_id = $1", [otherOrgInvoice]);
    expect(untouched.rowCount).toBe(0);
  });
});
