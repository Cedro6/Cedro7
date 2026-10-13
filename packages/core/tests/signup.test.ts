import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appUrl, createPool, migrate, ownerUrl, seed, type Pool } from "@bos/db";
import {
  adjustStock, beginTwoStep, confirmTwoStep, platformResetTwoStep, setCompanySuspended, setRequireTwoStep, totpCode, totpStep, twoStepStatus, confirmOrder, createCustomer, createProduct, createQuote, createSignupLink, currentMembership, getRegion, getSettings, listCompanies, listCustomers,
  listHistory, listProducts, listSignupLinks, revokeSignupLink, signInWithPassword, signUp, signupLinkValid, TYPE_FEATURES, ValidationError, type Ctx, type SignupInput,
} from "../src/index";

let owner: Pool;
let app: Pool;
let userId: string;
const GOOD = "correct horse battery";
const input = (over: Partial<SignupInput> = {}): SignupInput => ({
  company: "Northwind Marine", businessType: "retail", timeZone: "America/Chicago", currency: "CAD", taxPercent: 13,
  name: "Pat Rivera", email: "Pat@Northwind.test", password: GOOD, ...over,
});

beforeAll(async () => {
  owner = createPool(ownerUrl());
  app = createPool(appUrl());
  await owner.query("drop schema public cascade; create schema public;");
  await migrate(owner);
  ({ userId } = await seed(owner));
});
afterAll(async () => {
  await app.end();
  await owner.end();
});

describe("sign-up by invitation", () => {
  let token: string;
  let ctx: Ctx;

  it("makes a link that is valid until it is used, and refuses made-up ones", async () => {
    ({ token } = await createSignupLink(app, userId, "Pat at Northwind"));
    expect(await signupLinkValid(app, token)).toBe(true);
    expect(await signupLinkValid(app, "x".repeat(43))).toBe(false);
    expect(await signupLinkValid(app, "'; drop table users; --")).toBe(false);
    expect((await listSignupLinks(app))[0]).toMatchObject({ note: "Pat at Northwind", state: "open", companyName: null });
    await expect(signUp(app, "x".repeat(43), input())).rejects.toThrow(/used or has expired/);
  });

  it("says what to fix without using up the link", async () => {
    for (const bad of [{ company: " " }, { businessType: "bakery" }, { timeZone: "Mars/Base" }, { currency: "XXX" }, { taxPercent: 100 }, { name: "" }, { email: "nope" }, { password: "short" }, { password: "pat-is-great-2026" }] as Partial<SignupInput>[]) {
      await expect(signUp(app, token, input(bad)), JSON.stringify(bad)).rejects.toBeInstanceOf(ValidationError);
    }
    // An email that already has a login is refused, and the link still works afterwards.
    await expect(signUp(app, token, input({ email: "amara@harborsupply.example" }))).rejects.toThrow(/already has a login/);
    expect(await signupLinkValid(app, token)).toBe(true);
    expect((await listCompanies(app)).map((c) => c.name)).not.toContain("Northwind Marine");
  });

  it("creates the company and its owner, set up for that kind of business", async () => {
    const before = (await listCompanies(app)).length;
    const session = await signUp(app, token, input());
    expect(session.sessionVersion).toBe(1);
    const m = (await currentMembership(app, session.orgId, session.userId))!;
    expect(m).toMatchObject({ orgName: "Northwind Marine", role: "owner", userName: "Pat Rivera", businessType: "retail", timeZone: "America/Chicago", currency: "CAD" });
    ctx = { pool: app, orgId: session.orgId, userId: session.userId, role: m.role, features: m.features, timeZone: m.timeZone, currency: m.currency };
    expect(await getRegion(ctx)).toEqual({ timeZone: "America/Chicago", currency: "CAD", defaultTaxPercent: 13 });
    const settings = await getSettings(ctx);
    for (const [id, on] of Object.entries(settings.features)) expect(on, id).toBe((TYPE_FEATURES.retail as readonly string[]).includes(id));
    expect(await listCompanies(app)).toHaveLength(before + 1);
    expect((await listSignupLinks(app))[0]).toMatchObject({ state: "used", companyName: "Northwind Marine" });
    // The owner signs in with the email in any letter case.
    const signedIn = await signInWithPassword(app, "pat@northwind.test", GOOD);
    expect(signedIn).toMatchObject({ ok: true, session: { userId: session.userId, orgId: session.orgId, twoStep: false } });
    expect((await owner.query("select password_hash from user_credentials where user_id = $1", [session.userId])).rows[0].password_hash).not.toContain(GOOD);
  });

  it("works once", async () => {
    expect(await signupLinkValid(app, token)).toBe(false);
    await expect(signUp(app, token, input({ email: "second@northwind.test" }))).rejects.toThrow(/used or has expired/);
  });

  it("starts empty and fully working: products, stock, customers and orders", async () => {
    expect(await listCustomers(ctx)).toEqual([]);
    expect(await listProducts(ctx)).toEqual([]);
    const product = await createProduct(ctx, { sku: "NW-1", name: "Dock line", price: 30, cost: 12 });
    await adjustStock(ctx, { productId: product.id, qtyDelta: 10, reason: "Opening count", idempotencyKey: randomUUID() });
    const customer = await createCustomer(ctx, { name: "First Customer" });
    const quote = await createQuote(ctx, { customerId: customer.id, lines: [{ productId: product.id, qty: 2 }] });
    expect(quote.number).toBe("SO-000001");
    expect((await confirmOrder(ctx, quote.id)).reserved).toBe(2);
    expect((await listProducts(ctx))[0]).toMatchObject({ onHand: 10, available: 8 });
    expect((await listHistory(ctx)).entries.at(-1)).toMatchObject({ who: "Pat Rivera" });
    // The first company on the service sees none of it.
    const first = (await owner.query<{ id: string }>("select id from organizations where slug = 'harbor-supply'")).rows[0]!.id;
    const theirs: Ctx = { pool: app, orgId: first, userId, role: "owner" };
    expect((await listProducts(theirs)).some((p) => p.sku === "NW-1")).toBe(false);
    expect((await listCustomers(theirs)).some((c) => c.name === "First Customer")).toBe(false);
  });

  it("gives two companies with the same name their own separate accounts", async () => {
    const again = await createSignupLink(app, userId, "Another Northwind");
    const session = await signUp(app, again.token, input({ email: "sam@other-northwind.test", name: "Sam Lee" }));
    const slugs = (await owner.query<{ slug: string }>("select slug from organizations where name = 'Northwind Marine' order by created_at")).rows.map((r) => r.slug);
    expect(slugs).toEqual(["northwind-marine", "northwind-marine-2"]);
    expect(session.orgId).not.toBe(ctx.orgId);
    const odd = await createSignupLink(app, userId, "");
    await signUp(app, odd.token, input({ company: "日本", email: "x@nihon.test" }));
    expect((await listCompanies(app)).some((c) => c.name === "日本")).toBe(true);
  });

  it("lets an unused link be cancelled, and keeps links where the app's database role cannot read them", async () => {
    const link = await createSignupLink(app, userId, "Changed my mind");
    const row = (await listSignupLinks(app)).find((l) => l.note === "Changed my mind")!;
    expect(await revokeSignupLink(app, row.id)).toBe(true);
    expect(await signupLinkValid(app, link.token)).toBe(false);
    expect((await listSignupLinks(app)).find((l) => l.id === row.id)!.state).toBe("expired");
    expect(await revokeSignupLink(app, row.id)).toBe(false);
    await expect(app.query("select * from signup_invites")).rejects.toThrow(/permission denied/);
    const stored = (await owner.query("select token_hash from signup_invites where id = $1", [row.id])).rows[0].token_hash;
    expect(stored).not.toContain(link.token);
  });
});

describe("running the service", () => {
  it("suspends a company and switches it back on, deleting nothing", async () => {
    const link = await createSignupLink(app, userId, "Suspend me");
    const s = await signUp(app, link.token, input({ company: "Lapsed Ltd", email: "owner@lapsed.test" }));
    expect((await currentMembership(app, s.orgId, s.userId))!.suspended).toBe(false);
    expect(await setCompanySuspended(app, s.orgId, true)).toBe(true);
    expect((await currentMembership(app, s.orgId, s.userId))!.suspended).toBe(true);
    expect((await listCompanies(app)).find((c) => c.id === s.orgId)!.suspended).toBe(true);
    // Other companies carry on.
    const first = (await owner.query<{ id: string }>("select id from organizations where slug = 'harbor-supply'")).rows[0]!.id;
    expect((await currentMembership(app, first, userId))!.suspended).toBe(false);
    expect(await setCompanySuspended(app, s.orgId, false)).toBe(true);
    expect((await currentMembership(app, s.orgId, s.userId))!.suspended).toBe(false);
    expect(await setCompanySuspended(app, "00000000-0000-4000-8000-000000000000", true)).toBe(false);
    expect(await setCompanySuspended(app, "nope", true)).toBe(false);
  });

  it("lets a company require two-step verification, but only once the person asking uses it", async () => {
    const link = await createSignupLink(app, userId, "Strict");
    const s = await signUp(app, link.token, input({ company: "Strict Co", email: "owner@strict.test" }));
    const ctx: Ctx = { pool: app, orgId: s.orgId, userId: s.userId, role: "owner" };
    await expect(setRequireTwoStep(ctx, true)).rejects.toThrow(/your own login first/);
    const setup = await beginTwoStep(ctx, "Cedro Terminal");
    await confirmTwoStep(ctx, totpCode(setup.secret, totpStep()));
    await setRequireTwoStep(ctx, true);
    expect((await currentMembership(app, s.orgId, s.userId))!.requireTwoStep).toBe(true);
    await expect(setRequireTwoStep({ ...ctx, role: "sales" }, false)).rejects.toThrow();
    // Locked out with nobody above them: whoever runs the service can reset their two-step.
    expect((await twoStepStatus(app, s.userId)).on).toBe(true);
    expect(await platformResetTwoStep(app, "Owner@Strict.test")).toBe(true);
    expect((await twoStepStatus(app, s.userId)).on).toBe(false);
    expect(await platformResetTwoStep(app, "owner@strict.test")).toBe(false);
    expect(await platformResetTwoStep(app, "not an email")).toBe(false);
    await setRequireTwoStep(ctx, false);
    expect((await currentMembership(app, s.orgId, s.userId))!.requireTwoStep).toBe(false);
  });
});
