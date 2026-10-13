import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appUrl, createPool, migrate, ownerUrl, seed, type Pool } from "@bos/db";
import {
  attention, createExpense, createInvoice, createQuote, currentMembership, ForbiddenError, getCustomer, getExpense, getOrder, getRegion, isTimeZone, listCustomers, listProducts,
  moneyText, salesSeries, today, todayIn, updateCustomer, updateRegion, ValidationError, zoneOf, type Ctx, type Role,
} from "../src/index";

let owner: Pool;
let app: Pool;
let orgId: string;
let userId: string;
const as = (role: Role, extra: Partial<Ctx> = {}): Ctx => ({ pool: app, orgId, userId, role, ...extra });

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

describe("time zone and currency", () => {
  it("starts on Eastern time and US dollars, and saves a change", async () => {
    expect(await getRegion(as("owner"))).toEqual({ timeZone: "America/New_York", currency: "USD", defaultTaxPercent: 0 });
    await updateRegion(as("owner"), { timeZone: "Europe/London", currency: "GBP", defaultTaxPercent: 20 });
    expect(await getRegion(as("sales"))).toEqual({ timeZone: "Europe/London", currency: "GBP", defaultTaxPercent: 20 });
    const m = (await currentMembership(app, orgId, userId))!;
    expect([m.timeZone, m.currency]).toEqual(["Europe/London", "GBP"]);
    await updateRegion(as("owner"), { timeZone: "America/New_York", currency: "USD", defaultTaxPercent: 0 });
  });

  it("refuses unknown zones, currencies and tax rates, and anyone but an owner or admin", async () => {
    const good = { timeZone: "America/Chicago", currency: "USD", defaultTaxPercent: 5 };
    for (const bad of [{ timeZone: "Mars/Olympus" }, { timeZone: "x'; drop table users; --" }, { currency: "XXX" }, { defaultTaxPercent: 100 }, { defaultTaxPercent: -1 }, { defaultTaxPercent: 6.12345 }]) {
      await expect(updateRegion(as("owner"), { ...good, ...bad })).rejects.toBeInstanceOf(ValidationError);
    }
    await expect(updateRegion(as("sales"), good)).rejects.toBeInstanceOf(ForbiddenError);
    expect(isTimeZone("Asia/Kolkata")).toBe(true);
    expect(isTimeZone("UTC")).toBe(true);
    expect(isTimeZone("")).toBe(false);
  });

  it("never lets an odd zone name reach a query", () => {
    expect(zoneOf({ timeZone: "Europe/Paris" })).toBe("Europe/Paris");
    expect(zoneOf({ timeZone: "x') or 1=1 --" })).toBe("America/New_York");
    expect(zoneOf({})).toBe("America/New_York");
  });

  it("works out today, and what is late, on the company's own clock", async () => {
    // Half past midnight UTC: still yesterday in New York, already tomorrow-ish in Auckland.
    const at = new Date("2026-03-10T00:30:00Z");
    expect(todayIn("America/New_York", at)).toBe("2026-03-09");
    expect(todayIn("Pacific/Auckland", at)).toBe("2026-03-10");
    expect(today(at)).toBe("2026-03-09");
    expect(today(at, "Asia/Tokyo")).toBe("2026-03-10");
    // A bill due on Kiritimati's "today" is not late there, but the same date is already past nowhere earlier.
    const ahead = "Pacific/Kiritimati"; // UTC+14
    const behind = "Pacific/Pago_Pago"; // UTC-11
    const dueOn = todayIn(behind);
    const { id } = await createExpense(as("owner"), { description: "Zone check", category: "Other", amount: 10, incurredOn: "2026-01-01", dueOn });
    expect((await getExpense(as("owner", { timeZone: behind }), id))!.daysLate).toBe(0);
    const late = (await getExpense(as("owner", { timeZone: ahead }), id))!.daysLate;
    expect(late).toBe(todayIn(ahead) === dueOn ? 0 : 1);
    // The sales chart ends on the company's own today.
    expect((await salesSeries(as("owner", { timeZone: ahead }), "30d"))!.to).toBe(todayIn(ahead));
    expect((await salesSeries(as("owner", { timeZone: behind }), "30d"))!.to).toBe(todayIn(behind));
  });

  it("writes money in the company's currency", async () => {
    expect(moneyText(1234.5, "GBP")).toBe("£1,234.50");
    expect(moneyText(1234.5, "EUR", true)).toBe("€1,235");
    expect(moneyText(5, "nonsense")).toBe("$5.00");
    await createExpense(as("owner"), { description: "Late one", category: "Other", amount: 250, incurredOn: "2026-01-01", dueOn: "2026-01-02" });
    const item = (await attention(as("owner", { currency: "EUR" }))).find((i) => i.kind === "overdue_bill")!;
    expect(item.detail).toContain("€");
  });
});

describe("tax defaults", () => {
  const quote = async (customerId: string, taxRatePercent?: number) => {
    const product = (await listProducts(as("owner"))).find((p) => p.available >= 5)!;
    const made = await createQuote(as("sales"), { customerId, taxRatePercent, lines: [{ productId: product.id, qty: 1, unitPrice: 100 }] });
    return (await getOrder(as("sales"), made.id))!;
  };

  it("uses the company's usual rate when none is given, and the given rate when one is", async () => {
    const [a] = await listCustomers(as("owner"));
    expect((await quote(a!.id)).taxRate).toBe(0);
    await updateRegion(as("owner"), { timeZone: "America/New_York", currency: "USD", defaultTaxPercent: 8.25 });
    const usual = await quote(a!.id);
    expect(usual.taxRate).toBeCloseTo(0.0825, 6);
    expect(usual.total).toBeCloseTo(108.25, 2);
    expect((await quote(a!.id, 5)).taxRate).toBeCloseTo(0.05, 6);
    expect((await quote(a!.id, 0)).taxRate).toBe(0);
  });

  it("charges no tax to a customer marked as not charged tax, on orders and invoices", async () => {
    const [a, b] = await listCustomers(as("owner"));
    await updateCustomer(as("sales"), b!.id, { name: b!.name, taxExempt: true });
    expect((await getCustomer(as("sales"), b!.id))!.taxExempt).toBe(true);
    expect((await quote(b!.id)).taxRate).toBe(0);
    expect((await quote(a!.id)).taxRate).toBeCloseTo(0.0825, 6);
    const line = [{ description: "Service call", qty: 1, unitPrice: 200 }];
    expect((await createInvoice(as("owner"), { customerId: b!.id, lines: line })).amount).toBe(200);
    expect((await createInvoice(as("owner"), { customerId: a!.id, lines: line })).amount).toBeCloseTo(216.5, 2);
    // Saving other details without mentioning tax leaves the setting alone.
    await updateCustomer(as("sales"), b!.id, { name: b!.name, paymentTerms: "Net 15" });
    expect((await getCustomer(as("sales"), b!.id))!.taxExempt).toBe(true);
  });
});
