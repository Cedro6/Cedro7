import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appUrl, createPool, migrate, ownerUrl, seed, type Pool } from "@bos/db";
import {
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
