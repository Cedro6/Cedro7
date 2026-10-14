import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appUrl, createPool, migrate, ownerUrl, seed, type Pool } from "@bos/db";
import {
  addDealerFile, addVehicleCost, cashReport, commissionReport, coverPhotos, createDeal, createVehicle, dealerAttention, dealerProfit, deliverDeal, getDeal,
  getDealerFile, listDealerFiles, listingRows, listVehicleCosts, makeCoverPhoto, publicVehiclePhoto, recordDealPayment, removeDealerFile, removeVehicleCost,
  salesTaxReport, toCsv, updateDealFollowUp, ForbiddenError, type Ctx, type DealPayment, type Role,
} from "../src/index";

let owner: Pool;
let app: Pool;
let orgId: string;
let userId: string;
const as = (role: Role): Ctx => ({ pool: app, orgId, userId, role, features: { dealer: true } });
const pay = (amount: number, method: string, paidOn: string): DealPayment => ({ id: `${method}${amount}${paidOn}`, amount, method, reference: null, paidOn, recordedBy: null });
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

beforeAll(async () => {
  owner = createPool(ownerUrl());
  app = createPool(appUrl());
  await owner.query("drop schema public cascade; create schema public;");
  await migrate(owner);
  ({ orgId, userId } = await seed(owner));
  await owner.query("update organizations set county_surtax_pct = 1.5, dealer_fee_default = 0, tag_title_default = 0");
});
afterAll(async () => {
  await app.end();
  await owner.end();
});

/** A car on the lot, sold and delivered for `price`, paid with `payments`. */
async function sell(price: number, payments: [number, string, string][], extra: { county?: string; deliver?: string; cost?: number } = {}) {
  const car = await createVehicle(as("owner"), { specs: { year: 2015, make: "Toyota", model: "Camry" }, own: { mileage: 90000, acquisitionPrice: extra.cost ?? 5000, askingPrice: price, status: "on_lot" } });
  const made = await createDeal(as("owner"), { vehicleId: car.id, buyerName: "Ana Ruiz", buyerAddress: "1 Bay Rd", buyerCity: "Tampa", buyerZip: "33602", buyerCounty: extra.county, salePrice: price, odometer: 90010 });
  for (const [amount, method, on] of payments) await recordDealPayment(as("owner"), made.id, { amount, method, paidOn: on });
  if (extra.deliver) await deliverDeal(as("owner"), made.id, extra.deliver);
  return { car, deal: made };
}

describe("Form 8300", () => {
  it("counts cash, and cashier's checks or money orders of $10,000 or less, and gives the 15-day due date", () => {
    expect(cashReport([pay(6000, "Cash", "2026-10-01"), pay(4000, "Cash", "2026-10-03")]).required).toBe(false); // exactly 10,000 is not over
    const r = cashReport([pay(6000, "Cash", "2026-10-01"), pay(3000, "Check", "2026-10-02"), pay(4500, "Cashier's check", "2026-10-05")]);
    expect(r.total).toBe(10500);
    expect(r.required).toBe(true);
    expect(r.crossedOn).toBe("2026-10-05");
    expect(r.dueOn).toBe("2026-10-20");
    // A single cashier's check over $10,000 is not cash; a bank transfer or card never is.
    expect(cashReport([pay(15000, "Cashier's check", "2026-10-01"), pay(9000, "Bank transfer", "2026-10-01"), pay(2000, "Card", "2026-10-01")]).required).toBe(false);
    expect(cashReport([pay(10500, "Money order", "2026-10-01")]).required).toBe(false);
    expect(cashReport([pay(8000, "Money order", "2026-10-01"), pay(2500, "Cash", "2026-10-02")]).dueOn).toBe("2026-10-17");
  });

  it("flags a deal until the filing date is recorded", async () => {
    const { deal } = await sell(12000, [[11000, "Cash", today()]]);
    const flagged = await dealerAttention(as("owner"));
    expect(flagged.find((a) => a.kind === "form_8300" && a.link === `/deals/${deal.id}`)?.title).toMatch(/Form 8300 due by/);
    await updateDealFollowUp(as("sales"), deal.id, { form8300FiledOn: today(), buyerOccupation: "Nurse" });
    expect((await dealerAttention(as("owner"))).some((a) => a.kind === "form_8300" && a.link === `/deals/${deal.id}`)).toBe(false);
    const d = (await getDeal(as("owner"), deal.id))!;
    expect(d.form8300FiledOn).toBe(today());
    expect(d.buyerOccupation).toBe("Nurse");
  });

  it("accepts the new payment types and refuses unknown ones", async () => {
    const { deal } = await sell(3000, [[500, "Money order", today()]]);
    await expect(recordDealPayment(as("owner"), deal.id, { amount: 1, method: "Bitcoin", paidOn: today() })).rejects.toThrow(/how it was paid/);
  });
});

describe("after the sale", () => {
  it("records the temp tag (30 days by default), the title application and the plate, and reminds before they lapse", async () => {
    const { deal } = await sell(4000, [[4000 + 240 + 60, "Card", daysAgo(26)]], { deliver: daysAgo(26) });
    let items = (await dealerAttention(as("owner"))).filter((a) => a.link === `/deals/${deal.id}`);
    expect(items.map((a) => a.kind)).toEqual(expect.arrayContaining(["title_due", "papers_missing"]));
    expect(items.find((a) => a.kind === "title_due")!.title).toContain(new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10));
    await updateDealFollowUp(as("sales"), deal.id, { tempTagNumber: "T123456", tempTagIssuedOn: daysAgo(26) });
    let d = (await getDeal(as("owner"), deal.id))!;
    expect(d.tempTagExpiresOn).toBe(new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10));
    items = (await dealerAttention(as("owner"))).filter((a) => a.link === `/deals/${deal.id}`);
    expect(items.find((a) => a.kind === "temp_tag")!.title).toMatch(/temp tag T123456 expires/);
    await updateDealFollowUp(as("sales"), deal.id, { titleSentOn: daysAgo(2), plateNumber: "ABC1234", titleDoneOn: today() });
    items = (await dealerAttention(as("owner"))).filter((a) => a.link === `/deals/${deal.id}`);
    expect(items.map((a) => a.kind)).toEqual(["papers_missing"]);
    d = (await getDeal(as("owner"), deal.id))!;
    expect([d.titleSentOn, d.plateNumber, d.titleDoneOn]).toEqual([daysAgo(2), "ABC1234", today()]);
    await expect(updateDealFollowUp(as("sales"), deal.id, { titleSentOn: "13/10/2026" })).rejects.toThrow(/YYYY-MM-DD/);
    await expect(updateDealFollowUp(as("viewer"), deal.id, { plateNumber: "X" })).rejects.toThrow(ForbiddenError);
  });

  it("records the salesperson for anyone who sells, and the commission only for people who see costs", async () => {
    const { deal } = await sell(5000, []);
    await updateDealFollowUp(as("sales"), deal.id, { salespersonId: userId, commission: 999 });
    let d = (await getDeal(as("owner"), deal.id))!;
    expect(d.salespersonId).toBe(userId);
    expect(d.commission).toBeNull(); // sales could not set it
    await updateDealFollowUp(as("owner"), deal.id, { commission: 250 });
    d = (await getDeal(as("owner"), deal.id))!;
    expect(d.commission).toBe(250);
    expect((await getDeal(as("sales"), deal.id))!.commission).toBeNull(); // nor see it
    await expect(updateDealFollowUp(as("owner"), deal.id, { salespersonId: "00000000-0000-0000-0000-000000000000" })).rejects.toThrow(/on your team/);
  });
});

describe("costs, profit, tax and commissions", () => {
  it("adds reconditioning to what a car cost, and takes it out of the gross", async () => {
    const { car, deal } = await sell(9000, []);
    await addVehicleCost(as("owner"), car.id, { kind: "recon", description: "Brakes", amount: 400, spentOn: today() });
    const tyres = await addVehicleCost(as("purchasing"), car.id, { kind: "parts", amount: 350.5, spentOn: today() });
    expect((await listVehicleCosts(as("owner"), car.id)).map((c) => c.amount)).toEqual([400, 350.5]);
    let d = (await getDeal(as("owner"), deal.id))!;
    expect(d.vehicleCosts).toBe(750.5);
    expect(d.gross).toBe(9000 - 5000 - 750.5);
    await removeVehicleCost(as("owner"), tyres);
    d = (await getDeal(as("owner"), deal.id))!;
    expect(d.gross).toBe(9000 - 5000 - 400);
    await expect(listVehicleCosts(as("sales"), car.id)).rejects.toThrow(ForbiddenError);
    await expect(addVehicleCost(as("owner"), car.id, { kind: "lunch", amount: 10, spentOn: today() })).rejects.toThrow(/what the money was for/);
  });

  it("reports profit, sales tax by county and commissions for a period", async () => {
    await owner.query("update deals set status = 'cancelled' where status = 'open'");
    const month = "2025-03";
    const a = await sell(8000, [[8000 + 480 + 75, "Card", "2025-03-05"]], { county: "Hillsborough", deliver: "2025-03-05", cost: 6000 });
    const b = await sell(3000, [[3000 + 180 + 45, "Card", "2025-03-20"]], { county: "Pinellas", deliver: "2025-03-20", cost: 2000 });
    await sell(4000, [[4000 + 240 + 60, "Card", "2025-04-01"]], { county: "Hillsborough", deliver: "2025-04-01" }); // next month
    await addVehicleCost(as("owner"), a.car.id, { kind: "detail", amount: 200, spentOn: "2025-03-01" });
    await updateDealFollowUp(as("owner"), a.deal.id, { salespersonId: userId, commission: 300 });

    const tax = await salesTaxReport(as("owner"), month);
    expect(tax.rows.map((r) => [r.county, r.deals, r.taxable, r.stateTax, r.surtax])).toEqual([
      ["Hillsborough", 1, 8000, 480, 75],
      ["Pinellas", 1, 3000, 180, 45],
    ]);
    expect(tax.totals).toMatchObject({ deals: 2, taxable: 11000, stateTax: 660, surtax: 120 });

    const profit = await dealerProfit(as("owner"), "2025-03-01", "2025-03-31");
    expect(profit.rows.map((r) => [r.number, r.gross, r.net])).toEqual([
      [a.deal.number, 8000 - 6000 - 200, 8000 - 6000 - 200 - 300],
      [b.deal.number, 1000, 1000],
    ]);
    expect(profit.totals).toMatchObject({ deals: 2, sales: 11000, gross: 2800, commission: 300, net: 2500, unknownCost: 0 });
    await expect(dealerProfit(as("sales"), "2025-03-01", "2025-03-31")).rejects.toThrow(ForbiddenError);

    const pay = await commissionReport(as("owner"), "2025-03-01", "2025-03-31");
    expect(pay.map((r) => [r.salespersonId, r.deals, r.commission])).toEqual([[userId, 1, 300], [null, 1, 0]]);
  });
});

describe("files and photos", () => {
  it("keeps signed papers with a deal and photos with a car; serves photos publicly only while the car is on the lot", async () => {
    const { car, deal } = await sell(7000, []);
    const signed = await addDealerFile(as("sales"), { dealId: deal.id, kind: "signed_form", name: "82040 signed.pdf", contentType: "application/pdf", data: new Uint8Array([0x25, 0x50, 0x44, 0x46]) });
    expect((await listDealerFiles(as("viewer"), { dealId: deal.id })).map((f) => [f.kind, f.name])).toEqual([["signed_form", "82040 signed.pdf"]]);
    expect(Buffer.from((await getDealerFile(as("viewer"), signed))!.data).toString()).toBe("%PDF");
    await expect(addDealerFile(as("sales"), { dealId: deal.id, kind: "signed_form", name: "virus.exe", contentType: "application/x-msdownload", data: JPEG })).rejects.toThrow(/photo .* or a PDF/);
    await expect(addDealerFile(as("sales"), { dealId: deal.id, kind: "signed_form", name: "big.pdf", contentType: "application/pdf", data: new Uint8Array(4_500_000) })).rejects.toThrow(/over 4.4 MB/);
    await expect(addDealerFile(as("viewer"), { dealId: deal.id, kind: "other", name: "x.pdf", contentType: "application/pdf", data: JPEG })).rejects.toThrow(ForbiddenError);

    const first = await addDealerFile(as("sales"), { vehicleId: car.id, kind: "photo", name: "front.jpg", contentType: "image/jpeg", data: JPEG });
    const second = await addDealerFile(as("sales"), { vehicleId: car.id, kind: "other", name: "side.jpg", contentType: "image/jpeg", data: JPEG });
    expect((await listDealerFiles(as("sales"), { vehicleId: car.id })).map((f) => [f.id, f.kind])).toEqual([[first, "photo"], [second, "photo"]]);
    await makeCoverPhoto(as("sales"), second);
    expect((await coverPhotos(as("sales"), [car.id]))[car.id]).toBe(second);
    expect((await listingRows(as("sales"))).find((r) => r.id === car.id)!.photoIds).toEqual([second, first]);

    // Public: on the lot yes, the deal's papers never, and not once the car is sold.
    expect((await publicVehiclePhoto(app, second))?.contentType).toBe("image/jpeg");
    expect(await publicVehiclePhoto(app, signed)).toBeNull();
    await owner.query("update vehicles set status = 'removed' where id = $1", [car.id]);
    expect(await publicVehiclePhoto(app, second)).toBeNull();

    await removeDealerFile(as("sales"), first);
    expect((await listDealerFiles(as("sales"), { vehicleId: car.id })).map((f) => f.id)).toEqual([second]);
  });

  it("writes CSV that spreadsheets cannot run", () => {
    expect(toCsv(["a", "b"], [["=HYPERLINK(1)", 'say "hi", ok'], [-5, null]])).toBe('"a","b"\r\n"\'=HYPERLINK(1)","say ""hi"", ok"\r\n"-5",""\r\n');
  });
});
