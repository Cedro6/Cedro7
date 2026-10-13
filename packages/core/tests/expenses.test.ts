import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appUrl, createPool, migrate, ownerUrl, seed, type Pool } from "@bos/db";
import {
  analysis, can, createExpense, expenseSummary, listExpensePayments, ForbiddenError, getExpense, listExpenses, listPurchaseOrders, listSuppliers, payExpense, resolveRange, StateError,
  today, ValidationError, voidExpense, type Ctx, type ExpenseInput, type Role,
} from "../src/index";

let owner: Pool;
let app: Pool;
let orgId: string;
let userId: string;
const as = (role: Role, features?: Ctx["features"]): Ctx => ({ pool: app, orgId, userId, role, features });
const day = (offset: number) => new Date(Date.parse(`${today()}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
const bill = (over: Partial<ExpenseInput> = {}): ExpenseInput => ({ description: "October rent", category: "Rent", amount: 1200, incurredOn: day(-5), ...over });

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

describe("bills and expenses", () => {
  it("records a bill, shows it as owed and late, then as paid", async () => {
    const { id } = await createExpense(as("owner"), bill({ dueOn: day(-2), reference: "INV-88" }));
    const made = (await getExpense(as("owner"), id))!;
    expect(made).toMatchObject({ description: "October rent", category: "Rent", amount: 1200, dueOn: day(-2), paidOn: null, daysLate: 2, reference: "INV-88" });
    const owing = await expenseSummary(as("owner"));
    expect(owing).toMatchObject({ owed: 1200, unpaid: 1, overdue: 1200, overdueCount: 1 });
    expect((await listExpenses(as("owner"), "unpaid")).map((e) => e.id)).toContain(id);
    await payExpense(as("owner"), id, { paidOn: today(), method: "Bank transfer" });
    expect(await getExpense(as("owner"), id)).toMatchObject({ paidOn: today(), paidMethod: "Bank transfer", daysLate: 0 });
    expect(await expenseSummary(as("owner"))).toMatchObject({ owed: 0, unpaid: 0, overdue: 0, paidThisMonth: 1200 });
    expect((await listExpenses(as("owner"), "unpaid")).map((e) => e.id)).not.toContain(id);
    expect((await listExpenses(as("owner"), "paid")).map((e) => e.id)).toContain(id);
    await expect(payExpense(as("owner"), id, { paidOn: today() })).rejects.toBeInstanceOf(StateError);
  });

  it("records something already paid, and counts what is due this week", async () => {
    const paid = await createExpense(as("owner"), bill({ description: "Card fees", category: "Bank and card fees", amount: 31.4, paidOn: day(-5), paidMethod: "Card" }));
    expect(await getExpense(as("owner"), paid.id)).toMatchObject({ paidOn: day(-5), paidMethod: "Card", amount: 31.4 });
    const before = await expenseSummary(as("owner"));
    await createExpense(as("owner"), bill({ description: "Electric", category: "Utilities", amount: 90, dueOn: day(3) }));
    await createExpense(as("owner"), bill({ description: "Insurance", category: "Insurance", amount: 400, dueOn: day(20) }));
    const after = await expenseSummary(as("owner"));
    expect(after.dueSoon - before.dueSoon).toBe(90);
    expect(after.owed - before.owed).toBe(490);
    expect(after.overdue).toBe(before.overdue);
  });

  it("ties a bill to a supplier and a purchase order, and refuses a mismatch", async () => {
    const suppliers = await listSuppliers(as("owner"));
    const made = await createExpense(as("purchasing"), bill({ description: "Fasteners delivery", category: "Stock purchases", amount: 389, supplierId: suppliers[0]!.id }));
    expect((await getExpense(as("owner"), made.id))!.supplierName).toBe(suppliers[0]!.name);
    const po = (await listPurchaseOrders(as("owner")))[0];
    if (po) {
      const linked = await createExpense(as("owner"), bill({ category: "Stock purchases", purchaseOrderId: po.id }));
      const got = (await getExpense(as("owner"), linked.id))!;
      expect(got.purchaseOrderNumber).toBe(po.number);
      expect(got.supplierName).toBeTruthy();
      const other = suppliers.find((s) => s.id !== got.supplierId);
      if (other) await expect(createExpense(as("owner"), bill({ purchaseOrderId: po.id, supplierId: other.id }))).rejects.toBeInstanceOf(ValidationError);
    }
    await expect(createExpense(as("owner"), bill({ supplierId: "00000000-0000-4000-8000-000000000000" }))).rejects.toBeInstanceOf(ValidationError);
  });

  it("voids a mistake so it stops counting, and keeps the record", async () => {
    const { id } = await createExpense(as("owner"), bill({ description: "Entered twice", amount: 77, dueOn: day(5) }));
    const before = await expenseSummary(as("owner"));
    await expect(voidExpense(as("owner"), id, " ")).rejects.toBeInstanceOf(ValidationError);
    await voidExpense(as("owner"), id, "Entered twice");
    expect((await expenseSummary(as("owner"))).owed).toBe(before.owed - 77);
    expect(await getExpense(as("owner"), id)).toMatchObject({ voided: true, voidReason: "Entered twice" });
    expect((await listExpenses(as("owner"), "all")).map((e) => e.id)).not.toContain(id);
    expect((await listExpenses(as("owner"), "voided")).map((e) => e.id)).toContain(id);
    await expect(payExpense(as("owner"), id, { paidOn: today() })).rejects.toBeInstanceOf(StateError);
    await expect(voidExpense(as("owner"), id, "again")).rejects.toBeInstanceOf(StateError);
  });

  it("refuses bad input", async () => {
    for (const bad of [
      { description: " " }, { category: "Snacks" }, { amount: 0 }, { amount: -5 }, { amount: 1.005 }, { amount: Number.NaN },
      { incurredOn: "2026-02-30" }, { dueOn: day(-9) }, { paidOn: "soon" }, { description: "x".repeat(201) },
    ] as Partial<ExpenseInput>[]) {
      await expect(createExpense(as("owner"), bill(bad)), JSON.stringify(bad)).rejects.toBeInstanceOf(ValidationError);
    }
    await expect(payExpense(as("owner"), "nope", { paidOn: today() })).rejects.toBeInstanceOf(ValidationError);
  });

  it("is limited to the roles that handle money, and switches off with the feature", async () => {
    for (const role of ["sales", "warehouse", "viewer"] as const) {
      expect(can(as(role), "expense.read")).toBe(false);
      await expect(listExpenses(as(role))).rejects.toBeInstanceOf(ForbiddenError);
      await expect(createExpense(as(role), bill())).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(can(as("purchasing"), "expense.write")).toBe(true);
    await expect(listExpenses(as("owner", { expenses: false }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createExpense(as("owner", { expenses: false }), bill())).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("keeps one company's bills out of another's", async () => {
    const other = await owner.query<{ id: string }>("insert into organizations (name, slug) values ('Other', 'other-expenses') returning id");
    const there: Ctx = { pool: app, orgId: other.rows[0]!.id, userId, role: "owner" };
    expect(await listExpenses(there, "all")).toEqual([]);
    expect((await expenseSummary(there)).owed).toBe(0);
    const mine = (await listExpenses(as("owner"), "all"))[0]!;
    expect(await getExpense(there, mine.id)).toBeNull();
    await expect(payExpense(there, mine.id, { paidOn: today() })).rejects.toBeInstanceOf(ValidationError);
    const supplier = (await listSuppliers(as("owner")))[0]!;
    await expect(createExpense(there, bill({ supplierId: supplier.id }))).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("profit in the report", () => {
  it("takes running costs off margin, leaves stock purchases out, and compares periods", async () => {
    const range = resolveRange("30d", today());
    const before = await analysis(as("owner"), { range });
    await createExpense(as("owner"), bill({ description: "Ads", category: "Marketing", amount: 250, incurredOn: day(-1) }));
    await createExpense(as("owner"), bill({ description: "Pallet of gloves", category: "Stock purchases", amount: 900, incurredOn: day(-1) }));
    await createExpense(as("owner"), bill({ description: "Old ads", category: "Marketing", amount: 100, incurredOn: day(-40) }));
    const voided = await createExpense(as("owner"), bill({ description: "Mistake", category: "Marketing", amount: 5000, incurredOn: day(-1) }));
    await voidExpense(as("owner"), voided.id, "Mistake");
    const after = await analysis(as("owner"), { range });
    expect(after.costs!.running.now - before.costs!.running.now).toBe(250);
    expect(after.costs!.running.was! - before.costs!.running.was!).toBe(100);
    expect(after.costs!.stockPurchases.now - before.costs!.stockPurchases.now).toBe(900);
    expect(after.costs!.profit!.now).toBeCloseTo(after.sales.margin!.now - after.costs!.running.now, 2);
    expect(before.costs!.profit!.now - after.costs!.profit!.now).toBeCloseTo(250, 2);
    expect(after.costs!.categories.reduce((n, c) => n + c.amount.now, 0)).toBeCloseTo(after.costs!.running.now + after.costs!.stockPurchases.now, 2);
    expect(after.costs!.owed).toBe((await expenseSummary(as("owner"))).owed);
  });

  it("is hidden from roles without access and when the feature is off", async () => {
    const range = resolveRange("30d", today());
    expect((await analysis(as("sales"), { range })).costs).toBeNull();
    expect((await analysis(as("owner", { expenses: false }), { range })).costs).toBeNull();
    expect((await analysis(as("purchasing"), { range })).costs!.profit).not.toBeNull();
  });
});

describe("part payments", () => {
  it("pays a bill in parts and counts it as paid only when nothing is left", async () => {
    const before = await expenseSummary(as("owner"));
    const { id } = await createExpense(as("owner"), bill({ description: "Insurance in instalments", category: "Insurance", amount: 900, dueOn: day(-1) }));
    expect(await getExpense(as("owner"), id)).toMatchObject({ paid: 0, balance: 900 });
    expect(await payExpense(as("owner"), id, { paidOn: today(), amount: 300, method: "Card" })).toEqual({ paid: 300, balance: 600 });
    expect(await getExpense(as("owner"), id)).toMatchObject({ paid: 300, balance: 600, paidOn: null, daysLate: 1 });
    const mid = await expenseSummary(as("owner"));
    expect(mid.owed - before.owed).toBe(600);
    expect(mid.overdue - before.overdue).toBe(600);
    expect(mid.paidThisMonth - before.paidThisMonth).toBe(300);
    expect((await listExpenses(as("owner"), "unpaid")).map((e) => e.id)).toContain(id);
    await expect(payExpense(as("owner"), id, { paidOn: today(), amount: 600.01 })).rejects.toThrow(/Only 600.00/);
    await expect(payExpense(as("owner"), id, { paidOn: today(), amount: 0 })).rejects.toBeInstanceOf(ValidationError);
    await expect(payExpense(as("owner"), id, { paidOn: today(), amount: 1.005 })).rejects.toBeInstanceOf(ValidationError);
    // With no amount given, the rest is paid.
    expect(await payExpense(as("owner"), id, { paidOn: today(), method: "Check" })).toEqual({ paid: 600, balance: 0 });
    expect(await getExpense(as("owner"), id)).toMatchObject({ paid: 900, balance: 0, paidOn: today(), paidMethod: "Check", daysLate: 0 });
    expect((await listExpensePayments(as("owner"), id)).map((p) => [p.amount, p.method])).toEqual([[300, "Card"], [600, "Check"]]);
    await expect(payExpense(as("owner"), id, { paidOn: today() })).rejects.toBeInstanceOf(StateError);
    expect((await expenseSummary(as("owner"))).owed).toBe(before.owed);
    expect((await analysis(as("owner"), { range: resolveRange("30d", today()) })).costs!.owed).toBe((await expenseSummary(as("owner"))).owed);
  });

  it("records one payment for something entered as already paid, and drops a voided part-paid bill from what is owed", async () => {
    const paid = await createExpense(as("owner"), bill({ description: "Paid at the till", amount: 42, paidOn: day(-2), paidMethod: "Cash" }));
    expect(await listExpensePayments(as("owner"), paid.id)).toMatchObject([{ amount: 42, paidOn: day(-2), method: "Cash" }]);
    const before = await expenseSummary(as("owner"));
    const { id } = await createExpense(as("owner"), bill({ description: "Wrong supplier", amount: 500 }));
    await payExpense(as("owner"), id, { paidOn: today(), amount: 100 });
    await voidExpense(as("owner"), id, "Entered against the wrong supplier");
    const after = await expenseSummary(as("owner"));
    expect(after.owed).toBe(before.owed);
    expect(after.paidThisMonth).toBe(before.paidThisMonth);
    expect(await getExpense(as("owner"), id)).toMatchObject({ voided: true, balance: 0 });
  });
});
