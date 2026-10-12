import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appUrl, createPool, migrate, ownerUrl, seed, type Pool } from "@bos/db";
import {
  createPasswordLink, ForbiddenError, hashPassword, inviteMember, listMembers, passwordLinkOwner, sessionVersion, setPasswordWithLink,
  signInWithPassword, updateMember, ValidationError, verifyPassword, type Ctx, type Role,
} from "../src/index";

let owner: Pool;
let app: Pool;
let orgId: string;
let userId: string;
const as = (role: Role, user = userId): Ctx => ({ pool: app, orgId, userId: user, role });
const GOOD = "correct horse battery";

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

describe("passwords", () => {
  it("hashes with a fresh salt each time and verifies only the right password", async () => {
    const a = await hashPassword(GOOD);
    const b = await hashPassword(GOOD);
    expect(a).not.toBe(b);
    expect(a).not.toContain(GOOD);
    expect(await verifyPassword(GOOD, a)).toBe(true);
    expect(await verifyPassword(GOOD + "x", a)).toBe(false);
    expect(await verifyPassword(GOOD, "garbage")).toBe(false);
  });

  it("keeps hashes and link secrets where the app's database role cannot read them", async () => {
    await expect(app.query("select * from user_credentials")).rejects.toThrow(/permission denied/);
    await expect(app.query("select * from auth_tokens")).rejects.toThrow(/permission denied/);
    await expect(app.query("insert into users (email, name) values ('x@y.test', 'X')")).rejects.toThrow(/permission denied/);
  });
});

describe("invites and sign-in", () => {
  let token: string;
  let invited: string;

  it("invites a person, who sets a password with the link once and can then sign in", async () => {
    const invite = await inviteMember(as("owner"), { name: "Dana Whitfield", email: "Dana@Harbor.test", role: "sales" });
    ({ token, userId: invited } = invite);
    expect(await passwordLinkOwner(app, token)).toMatchObject({ email: "dana@harbor.test", name: "Dana Whitfield", purpose: "invite" });
    expect((await listMembers(as("owner"))).find((m) => m.userId === invited)).toMatchObject({ role: "sales", hasPassword: false, status: "active" });
    expect(await signInWithPassword(app, "dana@harbor.test", GOOD)).toEqual({ ok: false, reason: "wrong" }); // no password yet

    await expect(setPasswordWithLink(app, token, "short")).rejects.toThrow(/at least 10/);
    await expect(setPasswordWithLink(app, token, "dana-is-great-2026")).rejects.toThrow(/email address/);
    const session = await setPasswordWithLink(app, token, GOOD);
    expect(session).toMatchObject({ userId: invited, orgId, sessionVersion: 1 });
    await expect(setPasswordWithLink(app, token, GOOD)).rejects.toThrow(/used or has expired/);
    expect(await passwordLinkOwner(app, token)).toBeNull();

    expect(await signInWithPassword(app, " DANA@harbor.test ", GOOD)).toEqual({ ok: true, session });
    expect((await listMembers(as("owner"))).find((m) => m.userId === invited)!.hasPassword).toBe(true);
    const stored = (await owner.query("select password_hash, (select token_hash from auth_tokens limit 1) as t from user_credentials where user_id = $1", [invited])).rows[0];
    expect(stored.password_hash.startsWith("scrypt$")).toBe(true);
    expect(stored.t).not.toBe(token);
  });

  it("gives the same answer for a wrong password and an unknown email", async () => {
    expect(await signInWithPassword(app, "dana@harbor.test", "wrong password!")).toEqual({ ok: false, reason: "wrong" });
    expect(await signInWithPassword(app, "nobody@nowhere.test", GOOD)).toEqual({ ok: false, reason: "wrong" });
  });

  it("locks the account after five wrong passwords, even for the right one, then lets it back in", async () => {
    for (let i = 0; i < 4; i++) await signInWithPassword(app, "dana@harbor.test", "wrong password!"); // five with the one above
    expect(await signInWithPassword(app, "dana@harbor.test", GOOD)).toEqual({ ok: false, reason: "locked" });
    await owner.query("update user_credentials set locked_until = now() - interval '1 minute' where user_id = $1", [invited]);
    expect((await signInWithPassword(app, "dana@harbor.test", GOOD)).ok).toBe(true);
    expect((await owner.query("select failed_count from user_credentials where user_id = $1", [invited])).rows[0].failed_count).toBe(0);
  });

  it("resets a password with a new link, which signs out older sessions and cancels older links", async () => {
    const first = await createPasswordLink(as("owner"), invited);
    const second = await createPasswordLink(as("owner"), invited);
    expect(await passwordLinkOwner(app, first.token)).toBeNull();
    expect(second.expiresAt.getTime() - Date.now()).toBeLessThan(61 * 60_000);
    await setPasswordWithLink(app, second.token, "a brand new passphrase");
    expect(await sessionVersion(app, invited)).toBe(2);
    expect((await signInWithPassword(app, "dana@harbor.test", GOOD)).ok).toBe(false);
    expect((await signInWithPassword(app, "dana@harbor.test", "a brand new passphrase")).ok).toBe(true);
  });

  it("refuses an expired link and a made-up one", async () => {
    const link = await createPasswordLink(as("owner"), invited);
    await owner.query("update auth_tokens set expires_at = now() - interval '1 second' where used_at is null");
    await expect(setPasswordWithLink(app, link.token, GOOD)).rejects.toThrow(/expired/);
    expect(await passwordLinkOwner(app, "x".repeat(43))).toBeNull();
    expect(await passwordLinkOwner(app, "'; drop table users; --")).toBeNull();
  });

  it("stops a suspended person signing in", async () => {
    await updateMember(as("owner"), invited, { status: "suspended" });
    expect(await signInWithPassword(app, "dana@harbor.test", "a brand new passphrase")).toEqual({ ok: false, reason: "wrong" });
    await expect(createPasswordLink(as("owner"), invited)).rejects.toThrow(/not an active member/);
    await updateMember(as("owner"), invited, { status: "active" });
    expect((await signInWithPassword(app, "dana@harbor.test", "a brand new passphrase")).ok).toBe(true);
  });
});

describe("team rules", () => {
  it("lets only people who manage settings invite, list or change the team", async () => {
    await expect(inviteMember(as("sales"), { name: "X", email: "x@harbor.test", role: "viewer" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listMembers(as("warehouse"))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createPasswordLink(as("sales"), userId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateMember(as("sales"), userId, { role: "viewer" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("validates an invite and refuses someone already on the team", async () => {
    await expect(inviteMember(as("owner"), { name: "X", email: "not-an-email", role: "sales" })).rejects.toBeInstanceOf(ValidationError);
    await expect(inviteMember(as("owner"), { name: "X", email: "x@harbor.test", role: "emperor" })).rejects.toBeInstanceOf(ValidationError);
    await expect(inviteMember(as("owner"), { name: "Dana", email: "dana@harbor.test", role: "sales" })).rejects.toThrow(/already on the team/);
  });

  it("always keeps one active owner and never lets an admin touch an owner", async () => {
    const members = await listMembers(as("owner"));
    const theOwner = members.find((m) => m.role === "owner")!;
    await expect(updateMember(as("owner", theOwner.userId), theOwner.userId, { role: "sales" })).rejects.toThrow(/at least one active owner/);
    await expect(updateMember(as("owner", theOwner.userId), theOwner.userId, { status: "suspended" })).rejects.toThrow(/cannot suspend yourself/);
    await expect(updateMember(as("admin"), theOwner.userId, { role: "viewer" })).rejects.toThrow(/Only an owner/);
    await expect(inviteMember(as("admin"), { name: "Second", email: "second@harbor.test", role: "owner" })).rejects.toThrow(/Only an owner/);
    await expect(createPasswordLink(as("admin"), theOwner.userId)).rejects.toThrow(/Only an owner/);
    const other = members.find((m) => m.role !== "owner")!;
    await updateMember(as("owner"), other.userId, { role: "owner" });
    await updateMember(as("owner", other.userId), theOwner.userId, { role: "admin" }); // fine now there are two
    expect((await listMembers(as("owner", other.userId))).filter((m) => m.role === "owner")).toHaveLength(1);
  });

  it("cannot issue a link for someone in another company", async () => {
    const otherOrg = (await owner.query<{ id: string }>("insert into organizations (name, slug) values ('Other Co', 'other-co') returning id")).rows[0]!.id;
    const outsider = (await owner.query<{ id: string }>("insert into users (email, name) values ('out@other.test', 'Out') returning id")).rows[0]!.id;
    await owner.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')", [otherOrg, outsider]);
    await expect(createPasswordLink(as("owner"), outsider)).rejects.toThrow(/not an active member/);
    await expect(app.query("select auth_issue_token($1, $2, 'reset', 'abc', null)", [orgId, outsider])).rejects.toThrow(/not a member/);
  });
});
