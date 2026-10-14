import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appUrl, createPool, migrate, ownerUrl, seed, type Pool } from "@bos/db";
import { activeMemberCount, applySubscription, billingState, checkRoomForMember, currentMembership, extraUsers, PLANS, readBilling, yearlyPrice, type BillingRow } from "../src/index";

let owner: Pool;
let app: Pool;
let orgId: string;
let userId: string;

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

const NOW = new Date("2026-10-14T12:00:00Z");
const row = (over: Partial<BillingRow> = {}): BillingRow => ({
  exempt: false, trialEndsAt: new Date("2026-10-20T12:00:00Z"), plan: null, interval: null, status: null,
  customerId: null, subscriptionId: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, ...over,
});
const at = (r: BillingRow, enabled = true) => billingState(r, { enabled, now: NOW, defaultAvaQuestions: 300 });

describe("plans", () => {
  it("prices a year at ten months and bills extra users only where the plan allows", () => {
    expect(yearlyPrice(PLANS.dealer)).toBe(990);
    expect(yearlyPrice(PLANS.cedro_basic)).toBe(390);
    expect(extraUsers("cedro_corporate", 30)).toBe(5);
    expect(extraUsers("cedro_corporate", 12)).toBe(0);
  });
});

describe("where a company stands", () => {
  it("never limits or locks anyone while billing is switched off, or for an exempt company", () => {
    const ended = row({ trialEndsAt: new Date("2026-10-01T00:00:00Z") });
    expect(at(ended, false)).toMatchObject({ phase: "exempt", locked: false, userLimit: null, avaQuestions: 300 });
    expect(at({ ...ended, exempt: true })).toMatchObject({ phase: "exempt", locked: false });
  });

  it("counts down a trial, then locks when it ends without a plan", () => {
    expect(at(row())).toMatchObject({ phase: "trial", locked: false, trialDaysLeft: 6, userLimit: 10, avaQuestions: 200 });
    expect(at(row({ trialEndsAt: new Date("2026-10-14T11:00:00Z") }))).toMatchObject({ phase: "ended", locked: true });
  });

  it("follows Stripe: paid is open, a failed payment still open with a warning, cancelled or unpaid locked", () => {
    const paid = row({ plan: "cedro_small", interval: "month", status: "active", subscriptionId: "sub_1", trialEndsAt: new Date("2026-01-01") });
    expect(at(paid)).toMatchObject({ phase: "active", locked: false, userLimit: 10, extraUsersBilled: false, avaQuestions: 1000 });
    expect(at({ ...paid, status: "trialing" })).toMatchObject({ phase: "active", locked: false });
    expect(at({ ...paid, status: "past_due" })).toMatchObject({ phase: "past_due", locked: false });
    expect(at({ ...paid, status: "unpaid" })).toMatchObject({ phase: "ended", locked: true });
    expect(at({ ...paid, status: "canceled" })).toMatchObject({ phase: "ended", locked: true });
    // A first payment still being attempted at checkout does not end a trial that is still running.
    expect(at({ ...paid, status: "incomplete", trialEndsAt: new Date("2026-10-20T12:00:00Z") })).toMatchObject({ phase: "trial", locked: false });
  });

  it("charges for extra people on Corporate and Dealer Terminal, and stops Basic at its limit", () => {
    const corporate = at(row({ plan: "cedro_corporate", interval: "year", status: "active" }));
    expect(corporate).toMatchObject({ userLimit: null, extraUsersBilled: true });
    expect(() => checkRoomForMember(corporate, 40)).not.toThrow();
    const basic = at(row({ plan: "cedro_basic", interval: "month", status: "active" }));
    expect(() => checkRoomForMember(basic, 2)).not.toThrow();
    expect(() => checkRoomForMember(basic, 3)).toThrow(/Basic plan includes 3 people/);
    expect(() => checkRoomForMember(at(row()), 10)).toThrow(/free trial allows 10 people/);
  });
});

describe("billing in the database", () => {
  it("starts new companies on a trial (30 days for dealers, 14 otherwise), while companies from before billing are exempt", async () => {
    // The seeded company was made after the billing change, so it is on a trial.
    const seeded = await readBilling({ pool: app, orgId });
    expect(seeded.exempt).toBe(false);
    const made = await owner.query<{ id: string; created_at: Date; trial_ends_at: Date }>(
      "insert into organizations (name, slug, business_type) values ('Lot', 'lot-x', 'dealer'), ('Shop', 'shop-x', 'retail') returning id, created_at, trial_ends_at",
    );
    const days = made.rows.map((r) => Math.round((r.trial_ends_at.getTime() - r.created_at.getTime()) / 86_400_000));
    expect(days).toEqual([30, 14]);
    const m = await currentMembership(app, orgId, userId);
    expect(m!.billing).toMatchObject({ exempt: false, plan: null });
    expect(await activeMemberCount({ pool: app, orgId })).toBeGreaterThan(0);
  });

  it("stores Stripe's subscription, ignores an older notification arriving late, and refuses another company's customer", async () => {
    const base = { orgId, customerId: "cus_A", subscriptionId: "sub_A", plan: "dealer" as const, interval: "month" as const, currentPeriodEnd: new Date("2026-11-14"), cancelAtPeriodEnd: false };
    expect(await applySubscription(app, { ...base, status: "active", at: new Date("2026-10-14T10:00:00Z") })).toBe(true);
    expect(await applySubscription(app, { ...base, status: "past_due", at: new Date("2026-10-14T09:00:00Z") })).toBe(false); // older: ignored
    let b = await readBilling({ pool: app, orgId });
    expect([b.plan, b.interval, b.status, b.customerId]).toEqual(["dealer", "month", "active", "cus_A"]);
    expect(await applySubscription(app, { ...base, status: "past_due", at: new Date("2026-10-15T09:00:00Z") })).toBe(true);
    expect(await applySubscription(app, { ...base, customerId: "cus_OTHER", status: "active", at: new Date("2026-10-16T09:00:00Z") })).toBe(false);
    b = await readBilling({ pool: app, orgId });
    expect([b.status, b.customerId]).toEqual(["past_due", "cus_A"]);
    const logged = await owner.query("select 1 from audit_log where action = 'billing.subscription' and org_id = $1", [orgId]);
    expect(logged.rowCount).toBe(2);
  });
});
