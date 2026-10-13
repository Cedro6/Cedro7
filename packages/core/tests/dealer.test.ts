import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appUrl, createPool, migrate, ownerUrl, seed, type Pool } from "@bos/db";
import {
  cancelDeal, createDeal, dealMoney, deliverDeal, getDeal, listDeals, openDealFor, recordDealPayment, updateDeal,
  cleanVin, createVehicle, fromVpic, getVehicle, listVehicles, lookupVin, lotSummary, planVehicleImport, runVehicleImport, updateVehicle, useVinDecoder, vinProblem, vpicDecoder,
  ForbiddenError, ValidationError, StateError, type Ctx, type Role, type VinDecoder,
} from "../src/index";

let owner: Pool;
let app: Pool;
let orgId: string;
let userId: string;
const as = (role: Role, features?: Ctx["features"]): Ctx => ({ pool: app, orgId, userId, role, features: features ?? { dealer: true } });

// A 2013 Ford F-150 as vPIC describes it, and a VIN the decoder knows nothing about.
const F150 = "1FTFW1ET9DFC10312";
const MYSTERY = "5YJSA1E27HF000337";
const VPIC_ROW = { ModelYear: "2013", Make: "FORD", Model: "F-150", Trim: "", Series: "XLT", BodyClass: "Pickup", EngineModel: "", DisplacementL: "3.5", EngineCylinders: "6", EngineHP: "", TransmissionStyle: "", DriveType: "4WD/4-Wheel Drive/4x4", FuelTypePrimary: "Gasoline", VehicleType: "TRUCK", Manufacturer: "FORD MOTOR COMPANY, USA", Doors: "4", CabType: "Crew/ Super Crew/ Crew Max", BedLengthIN: "66.0", PlantCountry: "UNITED STATES (USA)", ErrorCode: "0", ErrorText: "0 - VIN decoded clean. Check Digit (9th position) is correct", GVWR: "Class 2E: 6,001 - 7,000 lb (2,722 - 3,175 kg)" };
let calls = 0;
const fake: VinDecoder = {
  name: "fake",
  decode: async (vin) => {
    calls++;
    if (vin === MYSTERY) return { provider: "fake", specs: {}, extra: {}, warnings: ["Unused position(s): 4-8; Check digit is correct"], raw: {} };
    return { provider: "fake", raw: { Results: [VPIC_ROW] }, ...fromVpic(VPIC_ROW) };
  },
};

beforeAll(async () => {
  owner = createPool(ownerUrl());
  app = createPool(appUrl());
  await owner.query("drop schema public cascade; create schema public;");
  await migrate(owner);
  ({ orgId, userId } = await seed(owner));
  useVinDecoder(fake);
});
afterAll(async () => {
  await app.end();
  await owner.end();
});

describe("VINs", () => {
  it("cleans and checks a VIN", () => {
    expect(cleanVin(" 1ftfw1et9dfc1o312 ")).toBe(F150);
    expect(vinProblem(F150)).toBeNull();
    expect(vinProblem("1FTFW1ET6DFC10312")).toMatch(/check digit/);
    expect(vinProblem("1FTFW1ET5DFC1031")).toMatch(/17 characters/);
    expect(vinProblem("WBA3A5C55DF000000")).toBeNull(); // European: the check digit rule is not applied
  });

  it("reads a vPIC row without inventing anything", () => {
    const got = fromVpic(VPIC_ROW);
    expect(got.specs).toEqual({ year: 2013, make: "Ford", model: "F-150", trim: "XLT", bodyStyle: "Pickup", displacementL: 3.5, cylinders: 6, drivetrain: "4WD/4-Wheel Drive/4x4", fuelType: "Gasoline", category: "TRUCK", manufacturer: "FORD MOTOR COMPANY, USA", doors: 4, cab: "Crew/ Super Crew/ Crew Max", bedLength: "66.0 in", madeIn: "UNITED STATES (USA)" });
    expect(got.specs).not.toHaveProperty("horsepower");
    expect(got.extra).toEqual({ GVWR: "Class 2E: 6,001 - 7,000 lb (2,722 - 3,175 kg)" });
    expect(got.warnings).toEqual([]);
    expect(fromVpic({ ...VPIC_ROW, ErrorCode: "1", ErrorText: "1 - Check Digit (9th position) does not calculate properly" }).warnings).toEqual(["Check Digit (9th position) does not calculate properly"]);
  });

  it("retries the real decoder on a server error and gives up with a plain message", async () => {
    let tries = 0;
    const flaky = vpicDecoder((async () => { tries++; return new Response("down", { status: 503 }); }) as typeof fetch, "https://example.invalid");
    await expect(flaky.decode(F150)).rejects.toThrow(/could not be reached/);
    expect(tries).toBe(3);
    const ok = vpicDecoder((async () => Response.json({ Results: [VPIC_ROW] })) as typeof fetch, "https://example.invalid");
    expect((await ok.decode(F150)).specs.make).toBe("Ford");
  });
});

describe("vehicles", () => {
  it("looks a VIN up, decoding it once for everyone, and names what the decoder could not say", async () => {
    calls = 0;
    const first = await lookupVin(as("owner"), " 1ftfw1et9dfc10312 ");
    expect(first.vin).toBe(F150);
    expect(first.decoded!.specs.model).toBe("F-150");
    expect(first.missing).toEqual(["engine", "horsepower", "transmission"]);
    expect(first.duplicate).toBeNull();
    await lookupVin(as("sales"), F150);
    expect(calls).toBe(1);
    await expect(lookupVin(as("owner"), "1FTFW1ET6DFC10312")).rejects.toThrow(ValidationError);
    await expect(lookupVin(as("viewer"), F150)).rejects.toThrow(ForbiddenError);
    await expect(lookupVin(as("owner", { dealer: false }), F150)).rejects.toThrow(ForbiddenError);
  });

  it("creates the record from the approved fields with a stock number, tracking what was typed", async () => {
    const look = await lookupVin(as("owner"), F150);
    const made = await createVehicle(as("sales"), { vin: F150, specs: { ...look.decoded!.specs, horsepower: 365, trim: "XLT" }, own: { mileage: 48210, acquisitionPrice: 18500, acquisitionSource: "Trade-in", condition: "Good", colour: "Blue" } });
    expect(made.stockNumber).toBe("STK-000001");
    const car = (await getVehicle(as("viewer"), made.id))!;
    expect(car.make).toBe("Ford");
    expect(car.horsepower).toBe(365);
    expect(car.provenance).toMatchObject({ make: "decoder", trim: "decoder", horsepower: "manual" });
    expect(car.specs.GVWR).toContain("Class 2E");
    expect(car.status).toBe("draft");
    expect(car.mileage).toBe(48210);
    // The same VIN cannot be on the lot twice, and the lookup says so.
    await expect(createVehicle(as("owner"), { vin: F150, specs: {} })).rejects.toThrow(StateError);
    expect((await lookupVin(as("owner"), F150)).duplicate?.stockNumber).toBe("STK-000001");
    // Sold, it can come back as a new record.
    await updateVehicle(as("owner"), made.id, { own: { status: "sold" } });
    expect((await getVehicle(as("owner"), made.id))!.soldAt).not.toBeNull();
    const again = await createVehicle(as("owner"), { vin: F150, specs: look.decoded!.specs });
    expect(again.stockNumber).toBe("STK-000002");
    await updateVehicle(as("owner"), again.id, { own: { status: "removed" } });
  });

  it("uses the last six of the VIN as the stock number when the dealer prefers that", async () => {
    await owner.query("update organizations set stock_number_style = 'vin6' where id = $1", [orgId]);
    const made = await createVehicle(as("owner"), { vin: MYSTERY, specs: { make: "Tesla", model: "Model S" }, own: { status: "on_lot", askingPrice: 32000 } });
    expect(made.stockNumber).toBe("000337");
    await owner.query("update organizations set stock_number_style = 'counter' where id = $1", [orgId]);
    const car = (await getVehicle(as("owner"), made.id))!;
    expect(car.provenance).toEqual({ make: "manual", model: "manual" });
    expect(car.status).toBe("on_lot");
  });

  it("refuses bad hand-typed values and a car with nothing to identify it", async () => {
    await expect(createVehicle(as("owner"), { specs: {} })).rejects.toThrow(/VIN, or at least/);
    await expect(createVehicle(as("owner"), { specs: { make: "Kia", model: "Soul" }, own: { mileage: -1 } })).rejects.toThrow(/mileage/i);
    await expect(createVehicle(as("owner"), { specs: { make: "Kia", model: "Soul", year: 99999 } })).rejects.toThrow(ValidationError);
    await expect(updateVehicle(as("viewer"), "00000000-0000-0000-0000-000000000000", { own: { mileage: 1 } })).rejects.toThrow(ForbiddenError);
  });

  it("plans a bulk import row by row, then imports only the clean rows", async () => {
    const csv = `VIN,Mileage,Cost,Color\n${F150},51000,"$17,900",Red\n1FTFW1ET6DFC10312,1,1,Bad check digit\n${F150},2,2,Repeat\n${MYSTERY},3,3,On the lot already\n,4,4,Blank\nWBA3A5C55DF000000,12000,9000,Silver`;
    const plan = await planVehicleImport(as("owner"), csv);
    expect(plan.rows.map((r) => r.problem)).toEqual([null, expect.stringMatching(/check digit/), expect.stringMatching(/earlier in the file/), expect.stringMatching(/Already on the lot/), "No VIN on this row.", null]);
    expect(plan.rows[0]!.summary).toBe("2013 Ford F-150 XLT");
    expect(plan.rows[0]!.own).toEqual({ mileage: 51000, acquisitionPrice: 17900, colour: "Red" });
    expect(plan.ready).toBe(2);
    const done = await runVehicleImport(as("owner"), csv);
    expect(done.added).toHaveLength(2);
    expect(done.skipped).toBe(4);
    const lot = await listVehicles(as("owner"), { status: "live" });
    expect(lot.map((v) => v.stockNumber).sort()).toEqual(["000337", "STK-000003", "STK-000004"].sort());
    expect(lot.find((v) => v.vin === F150)!.colour).toBe("Red");
    // The stand-in decoder calls every VIN an F-150, so the BMW row counts too; the sold and removed ones are included.
    expect(await listVehicles(as("owner"), { search: "f-150" })).toHaveLength(4);
    const summary = await lotSummary(as("owner"));
    expect(summary).toMatchObject({ live: 3, onLot: 1, draft: 2, aged: 0, invested: 17900 + 9000 });
    expect((await lotSummary(as("sales"))).invested).toBeNull();
  });
});

// The browser form spells the statuses and conditions out for itself; this keeps the two lists honest.
describe("the vehicle form's own lists", () => {
  it("match the core's", async () => {
    const fs = await import("node:fs");
    const form = fs.readFileSync(new URL("../../../apps/web/components/VehicleFields.tsx", import.meta.url), "utf8");
    const core = await import("../src/index");
    for (const status of core.VEHICLE_STATUSES) expect(form).toContain(`key: "${status}", label: "${core.VEHICLE_STATUS_TEXT[status]}"`);
    expect(form.replace(/\s+/g, "")).toContain(`constCONDITIONS=${JSON.stringify([...core.VEHICLE_CONDITIONS])};`);
  });
});

describe("deals", () => {
  it("works out Florida tax: 6% after trade-in, surtax on the first $5,000 only", () => {
    const m = dealMoney({ salePrice: 12000, dealerFee: 499, tradeAllowance: 2000, stateTaxPct: 6, surtaxPct: 1, surtaxCap: 5000, tagTitleFees: 225.5, otherFees: 0 }, 500);
    expect(m.taxable).toBe(10499);
    expect(m.stateTax).toBe(629.94);
    expect(m.surtax).toBe(50);
    expect(m.total).toBe(11404.44);
    expect(m.balance).toBe(10904.44);
    expect(dealMoney({ salePrice: 3000, dealerFee: 0, tradeAllowance: 0, stateTaxPct: 6, surtaxPct: 1.5, surtaxCap: 5000, tagTitleFees: 0, otherFees: 0 }).surtax).toBe(45);
  });

  it("sells a car: deal, payments, delivery paid in full, vehicle sold, trade-in on the lot", async () => {
    await owner.query("update organizations set county_surtax_pct = 1, dealer_fee_default = 399, tag_title_default = 100");
    const car = await createVehicle(as("owner"), { vin: "1HGCM82633A004352", specs: { year: 2003, make: "Honda", model: "Accord" }, own: { mileage: 150000, acquisitionPrice: 2500, status: "on_lot" } });
    const made = await createDeal(as("sales"), { vehicleId: car.id, buyerName: "Maria Lopez", buyerAddress: "12 Palm St", buyerCity: "Tampa", buyerZip: "33602", buyerDl: "L123-456-78-901-0", salePrice: 6000, odometer: 150210 });
    expect(made.number).toBe("DL-000001");
    let deal = (await getDeal(as("sales"), made.id))!;
    expect(deal.dealerFee).toBe(399); // the dealership's default
    expect(deal.taxable).toBe(6399);
    expect(deal.surtax).toBe(50);
    expect(deal.total).toBe(6399 + 383.94 + 50 + 100);
    expect(deal.gross).toBeNull(); // sales may not see cost
    expect((await getDeal(as("owner"), made.id))!.gross).toBe(6399 - 2500);
    // A second deal on the same car is refused while this one is open.
    await expect(createDeal(as("owner"), { vehicleId: car.id, buyerName: "Someone Else", salePrice: 1 })).rejects.toThrow(/already has an open deal/);
    // Not paid: cannot deliver.
    await expect(deliverDeal(as("owner"), made.id, "2026-10-13")).rejects.toThrow(/still owed/);
    await recordDealPayment(as("owner"), made.id, { amount: 1000, method: "Cash", paidOn: "2026-10-10" });
    await expect(recordDealPayment(as("owner"), made.id, { amount: 99999, method: "Cash", paidOn: "2026-10-13" })).rejects.toThrow(/more than/);
    deal = (await getDeal(as("owner"), made.id))!;
    await recordDealPayment(as("owner"), made.id, { amount: deal.balance, method: "Check", reference: "1042", paidOn: "2026-10-13" });
    deal = (await getDeal(as("owner"), made.id))!;
    expect(deal.balance).toBe(0);
    expect(deal.payments).toHaveLength(2);
    // Add a trade-in, then deliver.
    await updateDeal(as("owner"), made.id, { vehicleId: car.id, buyerName: "Maria Lopez", buyerAddress: "12 Palm St", buyerCity: "Tampa", buyerZip: "33602", salePrice: 6000, odometer: 150210, tradeVin: "5YJ3E1EA2JF000316", tradeAllowance: 0, tradeDescription: "2017 Tesla Model S", tradeMileage: 80000 });
    const delivered = await deliverDeal(as("owner"), made.id, "2026-10-13");
    expect(delivered.tradeInId).not.toBeNull();
    expect((await getVehicle(as("owner"), car.id))!.status).toBe("sold");
    const trade = (await getVehicle(as("owner"), delivered.tradeInId!))!;
    expect(trade.vin).toBe("5YJ3E1EA2JF000316");
    expect(trade.status).toBe("draft");
    expect(trade.acquisitionSource).toBe("Trade-in on DL-000001");
    deal = (await getDeal(as("owner"), made.id))!;
    expect(deal.status).toBe("delivered");
    await expect(updateDeal(as("owner"), made.id, { vehicleId: car.id, buyerName: "x", salePrice: 1 })).rejects.toThrow(/delivered deal cannot be changed/);
    expect((await listDeals(as("viewer"))).map((d) => d.number)).toContain("DL-000001");
    await expect(createDeal(as("viewer"), { vehicleId: car.id, buyerName: "x", salePrice: 1 })).rejects.toThrow(ForbiddenError);
  });

  it("cancels a deal and refuses to deliver without an address or odometer", async () => {
    const car = await createVehicle(as("owner"), { specs: { make: "Kia", model: "Soul" }, own: { status: "on_lot" } });
    const made = await createDeal(as("owner"), { vehicleId: car.id, buyerName: "Sam Ng", salePrice: 100, dealerFee: 0, tagTitleFees: 0 });
    await recordDealPayment(as("owner"), made.id, { amount: 107, method: "Cash", paidOn: "2026-10-13" });
    await expect(deliverDeal(as("owner"), made.id, "2026-10-13")).rejects.toThrow(/address/);
    await cancelDeal(as("owner"), made.id, "Buyer changed their mind");
    expect((await getDeal(as("owner"), made.id))!.status).toBe("cancelled");
    expect(await openDealFor(as("owner"), car.id)).toBeNull();
    expect((await getVehicle(as("owner"), car.id))!.status).toBe("on_lot");
  });
});

describe("a car added without a VIN", () => {
  it("can be given its VIN later, once, and not one already on the lot", async () => {
    const car = await createVehicle(as("owner"), { specs: { make: "Honda", model: "Civic", year: 2016 } });
    expect((await getVehicle(as("owner"), car.id))!.vin).toBeNull();
    await expect(updateVehicle(as("owner"), car.id, { vin: "1FTFW1ET9DFC10312" })).rejects.toThrow(/already on the lot/);
    await expect(updateVehicle(as("owner"), car.id, { vin: "1HGCM82633A00435" })).rejects.toThrow(/17 characters/);
    await updateVehicle(as("owner"), car.id, { vin: "1hgcm82633a004352" });
    expect((await getVehicle(as("owner"), car.id))!.vin).toBe("1HGCM82633A004352");
  });
});

describe("the dealer's sales chart", () => {
  it("counts delivered deals by the day they were delivered, at the sale price", async () => {
    const { dealSalesSeries } = await import("../src/index");
    // The earlier tests delivered on a fixed date; move it to today so this holds whenever it runs.
    await owner.query("update deals set delivered_on = (now() at time zone 'America/New_York')::date where status = 'delivered'");
    const s = (await dealSalesSeries(as("owner"), "30d"))!;
    expect(s.points).toHaveLength(30);
    // Earlier tests delivered one deal (the Accord at 6,000) and cancelled another.
    expect(s.total).toBe(6000);
    expect(s.cars).toBe(1);
    expect((await dealSalesSeries(as("owner"), "ytd"))!.bucket).toBe("week");
    expect(await dealSalesSeries(as("owner", { dealer: false }), "30d")).toBeNull();
  });

  it("counts deals written by the day they were written, and offers 7 days to 12 months", async () => {
    const { dealSeries } = await import("../src/index");
    await owner.query("update deals set created_at = now()");
    const all = await owner.query<{ status: string; n: number }>("select status, count(*)::int as n from deals group by status");
    const n = (st: string) => all.rows.find((r) => r.status === st)?.n ?? 0;
    const week = (await dealSeries(as("owner"), "7d"))!;
    expect(week.points).toHaveLength(7);
    expect(week.deals).toBe(n("open") + n("delivered"));
    expect(week.open).toBe(n("open"));
    expect(week.points.at(-1)!.deals).toBe(week.deals);
    const year = (await dealSeries(as("owner"), "12m"))!;
    expect(year.bucket).toBe("month");
    expect(year.points).toHaveLength(12);
    expect(year.deals).toBe(week.deals);
    expect(year.total).toBe(6000);
  });
});

describe("Ava on a dealer account", () => {
  it("is offered car and deal tools, not orders, invoices or stock, and can never touch money", async () => {
    const { toolsFor, actionsFor } = await import("../src/index");
    const dealer = as("owner", { dealer: true, calendar: true, expenses: true, stock: false, purchasing: false });
    const tools = toolsFor(dealer).map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["lot_attention", "find_vehicles", "vehicle_detail", "find_deals", "deal_detail", "dealer_sales", "find_customers"]));
    expect(tools).not.toEqual(expect.arrayContaining([expect.stringMatching(/^(needs_attention|list_orders|list_invoices|find_products|business_report|customer_account)$/)]));
    const actions = actionsFor(dealer).map((a) => a.name);
    expect(actions).toEqual(expect.arrayContaining(["propose_vehicle_status", "propose_vehicle_details", "propose_deal", "propose_deliver_deal"]));
    expect(actions).not.toEqual(expect.arrayContaining([expect.stringMatching(/quote|ship_order|invoice|return|stock_adjustment|payment|price/)]));
    // A Cedro account sees none of the dealer tools.
    expect(toolsFor(as("owner", { dealer: false })).map((t) => t.name)).not.toContain("find_vehicles");
  });

  it("starts a deal only at the asking price, and refuses a price, a car with none, or delivery before payment", async () => {
    const { ask, confirmProposal } = await import("../src/index");
    const who = { company: "Test Motors", person: "Dee", monthlyLimit: 1000 };
    const usage = { input_tokens: 1, output_tokens: 1 };
    const once = (name: string, input: Record<string, unknown>) => {
      let n = 0;
      return (async () => (n++ === 0 ? { stop_reason: "tool_use", usage, content: [{ type: "tool_use" as const, id: "x", name, input }] } : { stop_reason: "end_turn", usage, content: [{ type: "text" as const, text: "ok" }] })) as never;
    };
    const priced = await createVehicle(as("owner"), { specs: { make: "Mazda", model: "3" }, own: { status: "on_lot", askingPrice: 9995, mileage: 61000 } });
    const unpriced = await createVehicle(as("owner"), { specs: { make: "Kia", model: "Rio" }, own: { status: "on_lot" } });
    const cut = await ask(as("owner"), { ...who, question: "x" }, once("propose_deal", { vehicle_id: priced.id, buyer_name: "Ann Lee", sale_price: 8000 }));
    expect(cut.proposals).toHaveLength(0);
    const none = await ask(as("owner"), { ...who, question: "x" }, once("propose_deal", { vehicle_id: unpriced.id, buyer_name: "Ann Lee" }));
    expect(none.proposals).toHaveLength(0);
    const fair = await ask(as("owner"), { ...who, question: "x" }, once("propose_deal", { vehicle_id: priced.id, buyer_name: "Ann Lee" }));
    expect(fair.proposals[0]!.summary).toContain("asking price of $9,995.00");
    const done = await confirmProposal(as("owner"), fair.proposals[0]!.id);
    const deal = (await getDeal(as("owner"), done.link.split("/").pop()!))!;
    expect(deal.salePrice).toBe(9995);
    expect(deal.odometer).toBe(61000);
    const early = await ask(as("owner"), { ...who, question: "x" }, once("propose_deliver_deal", { deal_id: deal.id }));
    expect(early.proposals).toHaveLength(0);
  });
});
