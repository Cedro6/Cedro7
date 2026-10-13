import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appUrl, createPool, migrate, ownerUrl, seed, type Pool } from "@bos/db";
import {
  adjustStock,
  can,
  createSupplier,
  currentMembership,
  featureOn,
  FEATURES,
  featuresFor,
  ForbiddenError,
  getSettings,
  listCustomers,
  listProducts,
  listPurchaseOrders,
  listSuppliers,
  parseFeatures,
  setBusinessType,
  setFeature,
  ValidationError,
  type Ctx,
  type FeatureSet,
  type Role,
} from "../src/index";

let owner: Pool;
let app: Pool;
let orgId: string;
let userId: string;
let otherOrg: string;

/** Builds the acting person the way a signed-in request does: role plus the company's stored switches. */
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
  otherOrg = (
    await owner.query<{ id: string }>("insert into organizations (name, slug) values ('Other Co', 'other-co') returning id")
  ).rows[0]!.id;
});

afterAll(async () => {
  await owner.end();
  await app.end();
});

describe("feature rules", () => {
  it("treats a missing switch as on, so existing companies keep everything", () => {
    for (const id of FEATURES) expect(featureOn({}, id)).toBe(true);
    for (const id of FEATURES) expect(featureOn(undefined, id)).toBe(true);
  });

  it("turns off everything that needs stock when stock is off", () => {
    const set: FeatureSet = { stock: false, picking: true, warehouse: true, putaway: true, counts: true };
    for (const id of ["picking", "warehouse", "putaway", "counts"] as const) expect(featureOn(set, id)).toBe(false);
    expect(featureOn(set, "purchasing")).toBe(true);
  });

  it("gives each business type its starting set", () => {
    // A distributor starts with everything except the dealer add-on.
    expect(Object.entries(featuresFor("distributor")).filter(([, on]) => !on).map(([id]) => id)).toEqual(["dealer"]);
    const sales = featuresFor("sales");
    expect(sales.stock).toBe(false);
    expect(sales.purchasing).toBe(false);
    expect(sales.board).toBe(true);
    const retail = featuresFor("retail");
    expect(retail.stock).toBe(true);
    expect(retail.picking).toBe(false);
    expect(featuresFor("contractor").purchasing).toBe(true);
    expect(featuresFor("warehouse").reports).toBe(false);
  });

  it("ignores anything stored that is not a known switch with a true or false value", () => {
    expect(parseFeatures({ stock: false, bogus: true, reports: "yes" })).toEqual({ stock: false });
    expect(parseFeatures(null)).toEqual({});
  });

  it("withholds a feature's permissions while it is off, even from an owner", () => {
    const off = { role: "owner" as const, features: { purchasing: false, stock: false, reports: false } };
    expect(can(off, "purchase_order.read")).toBe(false);
    expect(can(off, "purchase_order.approve")).toBe(false);
    expect(can(off, "stock.adjust")).toBe(false);
    expect(can(off, "report.view")).toBe(false);
    expect(can(off, "customer.write")).toBe(true);
    expect(can(off, "sales_order.ship")).toBe(true);
  });
});

describe("company settings", () => {
  it("starts a company as a distributor with everything on", async () => {
    const settings = await getSettings(await as("sales"));
    expect(settings.businessType).toBe("distributor");
    expect(Object.values(settings.features).every(Boolean)).toBe(true);
  });

  it("lets only someone who manages settings change them", async () => {
    for (const role of ["sales", "purchasing", "warehouse", "viewer"] as const) {
      await expect(setBusinessType(await as(role), "sales")).rejects.toBeInstanceOf(ForbiddenError);
      await expect(setFeature(await as(role), "reports", false)).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("rejects a business type or feature that does not exist", async () => {
    await expect(setBusinessType(await as("owner"), "bakery")).rejects.toBeInstanceOf(ValidationError);
    await expect(setFeature(await as("owner"), "teleport", true)).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses purchasing on the server once the feature is off, and allows it again when back on", async () => {
    await setFeature(await as("owner"), "purchasing", false);
    const ctx = await as("owner");
    await expect(listSuppliers(ctx)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listPurchaseOrders(ctx)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createSupplier(ctx, { name: "Should not exist" })).rejects.toBeInstanceOf(ForbiddenError);
    const names = await owner.query("select 1 from suppliers where org_id = $1 and name = 'Should not exist'", [orgId]);
    expect(names.rowCount).toBe(0);
    // the always-on parts are untouched
    expect((await listCustomers(ctx)).length).toBeGreaterThan(0);
    expect((await listProducts(ctx)).length).toBeGreaterThan(0);

    await setFeature(await as("owner"), "purchasing", true);
    expect((await listSuppliers(await as("owner"))).length).toBeGreaterThan(0);
  });

  it("switching to a Sales business turns off stock and purchasing, and refuses stock adjustments", async () => {
    const settings = await setBusinessType(await as("owner"), "sales");
    expect(settings.businessType).toBe("sales");
    expect(settings.features.stock).toBe(false);
    expect(settings.features.counts).toBe(false);
    const ctx = await as("owner");
    const product = (await listProducts(ctx))[0]!;
    await expect(
      adjustStock(ctx, { productId: product.id, qtyDelta: 1, reason: "Should be refused", idempotencyKey: randomUUID() }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listSuppliers(ctx)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("will not turn on a feature that needs stock while stock is off", async () => {
    await expect(setFeature(await as("owner"), "counts", true)).rejects.toBeInstanceOf(ValidationError);
    await setFeature(await as("owner"), "stock", true);
    const settings = await setFeature(await as("owner"), "counts", true);
    expect(settings.features.counts).toBe(true);
  });

  it("records every change in the audit log", async () => {
    const log = await owner.query<{ action: string }>(
      "select action from audit_log where org_id = $1 and entity_type = 'organization' order by created_at",
      [orgId],
    );
    const actions = log.rows.map((r) => r.action);
    expect(actions.filter((a) => a === "settings.business_type_changed").length).toBe(1);
    expect(actions.filter((a) => a === "settings.feature_changed").length).toBe(4);
  });

  it("never touches another company's settings", async () => {
    await setBusinessType(await as("owner"), "contractor");
    const other = await owner.query<{ business_type: string; features: unknown }>(
      "select business_type, features from organizations where id = $1",
      [otherOrg],
    );
    expect(other.rows[0]!.business_type).toBe("distributor");
    expect(other.rows[0]!.features).toEqual({});
    await setBusinessType(await as("owner"), "distributor");
  });
});

describe("add-ons", () => {
  it("stay off until switched on, even for a company with no settings at all", async () => {
    const { featureOn, featuresFor } = await import("../src/index");
    expect(featureOn(undefined, "dealer")).toBe(false);
    expect(featureOn({}, "dealer")).toBe(false);
    expect(featureOn({ dealer: true }, "dealer")).toBe(true);
    expect(featureOn({}, "stock")).toBe(true);
    expect(featuresFor("dealer").dealer).toBe(true);
  });
});
