import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appUrl, createPool, migrate, ownerUrl, seed, type Pool } from "@bos/db";
import {
  beginTwoStep, confirmTwoStep, disableTwoStep, inviteMember, listMembers, pendingTwoStep, resetMemberTwoStep, setPasswordWithLink, signInWithPassword, totpCode,
  totpStep, twoStepStatus, ValidationError, verifyTwoStep, createPasswordLink, type Ctx, type Role,
} from "../src/index";

let owner: Pool;
let app: Pool;
let orgId: string;
let userId: string;
let dana: string;
const as = (role: Role, user = userId): Ctx => ({ pool: app, orgId, userId: user, role });
const GOOD = "correct horse battery";
const EMAIL = "dana@harbor.test";
/** A fixed moment, so codes do not straddle a 30-second boundary mid-test. Each test moves on by minutes. */
const T0 = Date.UTC(2031, 0, 1, 12, 0, 10);
const minute = 60_000;
const unlock = () => owner.query("update user_credentials set failed_count = 0, locked_until = null");

beforeAll(async () => {
  owner = createPool(ownerUrl());
  app = createPool(appUrl());
  await owner.query("drop schema public cascade; create schema public;");
  await migrate(owner);
  ({ orgId, userId } = await seed(owner));
  const invite = await inviteMember(as("owner"), { name: "Dana Whitfield", email: EMAIL, role: "sales" });
  dana = invite.userId;
  await setPasswordWithLink(app, invite.token, GOOD);
});
afterAll(async () => {
  await app.end();
  await owner.end();
});

describe("authenticator codes", () => {
  it("match the published test values for the standard", () => {
    // RFC 6238 appendix B, SHA-1, secret "12345678901234567890" (base32 below), truncated to six digits.
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    expect(totpCode(secret, Math.floor(59 / 30))).toBe("287082");
    expect(totpCode(secret, Math.floor(1111111109 / 30))).toBe("081804");
    expect(totpCode(secret, Math.floor(1234567890 / 30))).toBe("005924");
    expect(totpCode(secret, Math.floor(20000000000 / 30))).toBe("353130");
  });
});

describe("two-step verification", () => {
  let secret: string;
  let recovery: string[];

  it("is off until setup is finished with a correct code", async () => {
    expect(await twoStepStatus(app, dana)).toEqual({ on: false, recoveryLeft: 0 });
    const setup = await beginTwoStep(as("sales", dana), "Clivada");
    secret = setup.secret;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.uri).toContain(`secret=${secret}`);
    expect(setup.uri).toContain("otpauth://totp/Clivada%3Adana%40harbor.test");
    expect((await pendingTwoStep(as("sales", dana), "Clivada"))!.secret).toBe(secret);
    // Not on yet: sign-in still needs only the password.
    const before = await signInWithPassword(app, EMAIL, GOOD);
    expect(before.ok && before.session.twoStep).toBe(false);
    await expect(confirmTwoStep(as("sales", dana), "000000", T0)).rejects.toBeInstanceOf(ValidationError);
    ({ recoveryCodes: recovery } = await confirmTwoStep(as("sales", dana), totpCode(secret, totpStep(T0)), T0));
    expect(recovery).toHaveLength(8);
    expect(new Set(recovery).size).toBe(8);
    expect(recovery[0]).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
    expect(await twoStepStatus(app, dana)).toEqual({ on: true, recoveryLeft: 8 });
    expect(await pendingTwoStep(as("sales", dana), "Clivada")).toBeNull();
    expect((await listMembers(as("owner"))).find((m) => m.userId === dana)!.twoStep).toBe(true);
    await expect(beginTwoStep(as("sales", dana), "Clivada")).rejects.toThrow(/already on/);
  });

  it("then asks for a code after the password, and accepts each code once", async () => {
    const signedIn = await signInWithPassword(app, EMAIL, GOOD);
    expect(signedIn.ok && signedIn.session.twoStep).toBe(true);
    const now = T0 + 5 * minute;
    const code = totpCode(secret, totpStep(now));
    expect(await verifyTwoStep(app, dana, "123456", now)).toEqual({ ok: false, reason: "wrong" });
    expect(await verifyTwoStep(app, dana, code, now)).toMatchObject({ ok: true, usedRecovery: false, recoveryLeft: 8 });
    // The same code again, even seconds later, is refused.
    expect(await verifyTwoStep(app, dana, code, now + 5000)).toEqual({ ok: false, reason: "wrong" });
    // A code from the step just before is fine for a slow typist, but an old one is not.
    const later = T0 + 10 * minute;
    expect((await verifyTwoStep(app, dana, totpCode(secret, totpStep(later) - 1), later)).ok).toBe(true);
    expect((await verifyTwoStep(app, dana, totpCode(secret, totpStep(later) - 5), later)).ok).toBe(false);
    // Spaces typed between the digits are ignored.
    const spaced = T0 + 15 * minute;
    const c = totpCode(secret, totpStep(spaced));
    expect((await verifyTwoStep(app, dana, `${c.slice(0, 3)} ${c.slice(3)}`, spaced)).ok).toBe(true);
    await unlock();
  });

  it("accepts each recovery code once, in place of the app", async () => {
    const now = T0 + 20 * minute;
    expect(await verifyTwoStep(app, dana, recovery[0]!, now)).toMatchObject({ ok: true, usedRecovery: true, recoveryLeft: 7 });
    expect(await verifyTwoStep(app, dana, recovery[0]!, now)).toEqual({ ok: false, reason: "wrong" });
    expect((await verifyTwoStep(app, dana, recovery[1]!.toLowerCase().replace("-", ""), now)).ok).toBe(true);
    expect(await verifyTwoStep(app, dana, "AAAAA-AAAAA", now)).toEqual({ ok: false, reason: "wrong" });
    await unlock();
  });

  it("locks the account after five wrong codes, even for a right one", async () => {
    const now = T0 + 30 * minute;
    for (let i = 0; i < 5; i++) expect(await verifyTwoStep(app, dana, "000001", now)).toEqual({ ok: false, reason: "wrong" });
    expect(await verifyTwoStep(app, dana, totpCode(secret, totpStep(now)), now)).toEqual({ ok: false, reason: "locked" });
    expect(await signInWithPassword(app, EMAIL, GOOD)).toEqual({ ok: false, reason: "locked" });
    await unlock();
    expect((await verifyTwoStep(app, dana, totpCode(secret, totpStep(now)), now)).ok).toBe(true);
  });

  it("still asks for the code after a password reset link", async () => {
    const link = await createPasswordLink(as("owner"), dana);
    const session = await setPasswordWithLink(app, link.token, "another good password");
    expect(session.twoStep).toBe(true);
    await setPasswordWithLink(app, (await createPasswordLink(as("owner"), dana)).token, GOOD);
  });

  it("keeps the secrets where the app's database role cannot read them, and one person's code does not work for another", async () => {
    await expect(app.query("select * from user_totp")).rejects.toThrow(/permission denied/);
    await expect(app.query("update user_totp set confirmed_at = null")).rejects.toThrow(/permission denied/);
    const stored = (await owner.query("select secret, recovery_hashes from user_totp where user_id = $1", [dana])).rows[0];
    expect(stored.recovery_hashes).toHaveLength(6);
    expect(stored.recovery_hashes.join()).not.toContain(recovery[2]!.replace("-", ""));
    const now = T0 + 40 * minute;
    expect(await verifyTwoStep(app, userId, totpCode(secret, totpStep(now)), now)).toEqual({ ok: false, reason: "wrong" });
  });

  it("turns off only with the password and a current code", async () => {
    const now = T0 + 50 * minute;
    const code = () => totpCode(secret, totpStep(now));
    await expect(disableTwoStep(as("sales", dana), { password: "wrong password!", code: code() }, now)).rejects.toThrow(/password is not right/);
    await expect(disableTwoStep(as("sales", dana), { password: GOOD, code: "000002" }, now)).rejects.toThrow(/code is not right/);
    await unlock();
    await disableTwoStep(as("sales", dana), { password: GOOD, code: code() }, now);
    expect(await twoStepStatus(app, dana)).toEqual({ on: false, recoveryLeft: 0 });
    const signedIn = await signInWithPassword(app, EMAIL, GOOD);
    expect(signedIn.ok && signedIn.session.twoStep).toBe(false);
    // With it off, no code is accepted as a second step.
    expect((await verifyTwoStep(app, dana, code(), now)).ok).toBe(false);
    await unlock();
  });

  it("lets an owner or admin reset it for someone who lost their phone, but not an admin for an owner", async () => {
    const setup = await beginTwoStep(as("sales", dana), "Clivada");
    await confirmTwoStep(as("sales", dana), totpCode(setup.secret, totpStep(T0)), T0);
    await expect(resetMemberTwoStep(as("sales", dana), dana)).rejects.toThrow();
    await resetMemberTwoStep(as("admin"), dana);
    expect((await twoStepStatus(app, dana)).on).toBe(false);
    await expect(resetMemberTwoStep(as("admin"), userId)).rejects.toThrow(/Only an owner/);
    await expect(resetMemberTwoStep(as("owner"), "00000000-0000-4000-8000-000000000000")).rejects.toBeInstanceOf(ValidationError);
  });
});
