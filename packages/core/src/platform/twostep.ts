import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool } from "@bos/db/runtime";
import { withTenant } from "@bos/db/runtime";
import type { Ctx } from "./context";
import { ValidationError } from "./errors";
import { verifyPassword } from "./passwords";
import { requirePermission } from "./permissions";

/**
 * Two-step verification with an authenticator app (the standard six-digit, 30-second codes).
 * After the password, sign-in asks for the current code, or for one of eight one-time recovery
 * codes given out when it was switched on. Wrong codes count toward the same 15-minute lock as
 * wrong passwords, and a code is never accepted twice.
 */
const STEP = 30;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32(bytes: Buffer): string {
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  return (bits.match(/.{1,5}/g) ?? []).map((chunk) => B32[parseInt(chunk.padEnd(5, "0"), 2)]).join("");
}
function fromBase32(text: string): Buffer {
  let bits = "";
  for (const ch of text.toUpperCase().replace(/[^A-Z2-7]/g, "")) bits += B32.indexOf(ch).toString(2).padStart(5, "0");
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
}

/** The six-digit code for one 30-second step (RFC 6238, SHA-1). */
export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", fromBase32(secret)).update(counter).digest();
  const at = mac[mac.length - 1]! & 0x0f;
  return String((mac.readUInt32BE(at) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
export const totpStep = (now = Date.now()): number => Math.floor(now / 1000 / STEP);

/** The step a code belongs to, allowing the one before and after for clocks that are slightly off. Null when it matches none. */
function matchStep(secret: string, code: string, now: number): number | null {
  const given = Buffer.from(code);
  for (const step of [totpStep(now), totpStep(now) - 1, totpStep(now) + 1]) {
    const expected = Buffer.from(totpCode(secret, step));
    if (given.length === expected.length && timingSafeEqual(given, expected)) return step;
  }
  return null;
}

const recoveryHash = (code: string) => createHash("sha256").update(code.toUpperCase().replace(/[^A-Z0-9]/g, "")).digest("hex");
const cleanCode = (code: string) => code.replace(/[\s-]/g, "");

export type TwoStepStatus = { on: boolean; recoveryLeft: number };

export async function twoStepStatus(pool: Pool, userId: string): Promise<TwoStepStatus> {
  const r = await pool.query<{ recovery_left: number }>("select recovery_left from auth_totp_enabled($1::uuid[])", [[userId]]);
  return { on: r.rows.length > 0, recoveryLeft: r.rows[0]?.recovery_left ?? 0 };
}

async function emailOf(ctx: Ctx): Promise<string> {
  const email = await withTenant(ctx.pool, ctx.orgId, async (tx) => (await tx.query<{ email: string }>("select email from users where id = $1", [ctx.userId])).rows[0]?.email);
  if (!email) throw new ValidationError("code", "Your account was not found.");
  return email;
}

/**
 * Starts setup for the signed-in person: a new secret, and the address an authenticator app reads
 * from a QR code. Nothing is switched on until `confirmTwoStep` gets a correct code.
 */
export async function beginTwoStep(ctx: Ctx, issuer: string): Promise<{ secret: string; uri: string }> {
  const email = await emailOf(ctx);
  const secret = base32(randomBytes(20));
  const started = await ctx.pool.query<{ ok: boolean }>("select auth_totp_begin($1, $2) as ok", [ctx.userId, secret]);
  if (!started.rows[0]?.ok) throw new ValidationError("code", "Two-step verification is already on.");
  const label = encodeURIComponent(`${issuer}:${email}`);
  return { secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP}` };
}

/** The secret of a setup that was started but not finished, to show the QR code again. Null when there is none. */
export async function pendingTwoStep(ctx: Ctx, issuer: string): Promise<{ secret: string; uri: string } | null> {
  const r = await ctx.pool.query<{ secret: string; confirmed: boolean }>("select secret, confirmed from auth_totp_secret($1)", [ctx.userId]);
  const row = r.rows[0];
  if (!row || row.confirmed) return null;
  const label = encodeURIComponent(`${issuer}:${await emailOf(ctx)}`);
  return { secret: row.secret, uri: `otpauth://totp/${label}?secret=${row.secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP}` };
}

/** Switches two-step on once the person proves their app shows the right code. Returns the recovery codes, shown once. */
export async function confirmTwoStep(ctx: Ctx, code: string, now = Date.now()): Promise<{ recoveryCodes: string[] }> {
  const r = await ctx.pool.query<{ secret: string; confirmed: boolean }>("select secret, confirmed from auth_totp_secret($1)", [ctx.userId]);
  const row = r.rows[0];
  if (!row) throw new ValidationError("code", "Start the setup again.");
  if (row.confirmed) throw new ValidationError("code", "Two-step verification is already on.");
  const step = matchStep(row.secret, cleanCode(code), now);
  if (step === null) throw new ValidationError("code", "That code is not right. Check the app and try the code it shows now.");
  const recoveryCodes = Array.from({ length: 8 }, () => {
    const raw = base32(randomBytes(7)).slice(0, 10);
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  const done = await ctx.pool.query("select auth_totp_confirm($1, $2, $3::text[]) as ok", [ctx.userId, step, recoveryCodes.map(recoveryHash)]);
  if (!done.rows[0]?.ok) throw new ValidationError("code", "Two-step verification is already on.");
  await audit(ctx, "member.two_step_on", ctx.userId);
  return { recoveryCodes };
}

export type TwoStepCheck = { ok: true; usedRecovery: boolean; recoveryLeft: number } | { ok: false; reason: "wrong" | "locked" };

/**
 * Checks the second step at sign-in: the app's current code, or an unused recovery code.
 * A wrong answer counts toward the account lock; a code already used is refused.
 */
export async function verifyTwoStep(pool: Pool, userId: string, code: string, now = Date.now()): Promise<TwoStepCheck> {
  if ((await pool.query<{ locked: boolean }>("select auth_is_locked($1) as locked", [userId])).rows[0]?.locked) return { ok: false, reason: "locked" };
  const r = await pool.query<{ secret: string; confirmed: boolean }>("select secret, confirmed from auth_totp_secret($1)", [userId]);
  const row = r.rows[0];
  const given = cleanCode(code).slice(0, 40);
  let ok = false;
  let usedRecovery = false;
  if (row?.confirmed) {
    if (/^\d{6}$/.test(given)) {
      const step = matchStep(row.secret, given, now);
      ok = step !== null && Boolean((await pool.query("select auth_totp_use_step($1, $2) as ok", [userId, step])).rows[0]?.ok);
    } else if (/^[A-Za-z2-7]{10}$/.test(given)) {
      ok = Boolean((await pool.query("select auth_totp_use_recovery($1, $2) as ok", [userId, recoveryHash(given)])).rows[0]?.ok);
      usedRecovery = ok;
    }
  }
  await pool.query("select auth_record_attempt($1, $2)", [userId, ok]);
  if (!ok) return { ok: false, reason: "wrong" };
  return { ok: true, usedRecovery, recoveryLeft: (await twoStepStatus(pool, userId)).recoveryLeft };
}

/** Switches the signed-in person's own two-step off. Needs their password and a current code (or a recovery code). */
export async function disableTwoStep(ctx: Ctx, input: { password: string; code: string }, now = Date.now()): Promise<void> {
  const email = await emailOf(ctx);
  const cred = await ctx.pool.query<{ user_id: string; password_hash: string; locked: boolean }>("select * from auth_credential($1)", [email]);
  const row = cred.rows[0];
  if (!row || row.user_id !== ctx.userId) throw new ValidationError("password", "Your account was not found.");
  if (row.locked) throw new ValidationError("password", "Too many wrong tries. Try again in 15 minutes.");
  const passwordOk = await verifyPassword(input.password.slice(0, 200), row.password_hash);
  if (!passwordOk) {
    await ctx.pool.query("select auth_record_attempt($1, false)", [ctx.userId]);
    throw new ValidationError("password", "Your password is not right.");
  }
  const check = await verifyTwoStep(ctx.pool, ctx.userId, input.code, now);
  if (!check.ok) throw new ValidationError("code", check.reason === "locked" ? "Too many wrong tries. Try again in 15 minutes." : "That code is not right.");
  await ctx.pool.query("select auth_totp_disable($1)", [ctx.userId]);
  await audit(ctx, "member.two_step_off", ctx.userId);
}

/** For someone who lost their phone and their recovery codes: an owner or admin switches their two-step off. */
export async function resetMemberTwoStep(ctx: Ctx, userId: string): Promise<void> {
  requirePermission(ctx, "settings.manage");
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new ValidationError("userId", "That person was not found.");
  await withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const member = await tx.query<{ role: string }>("select role from memberships where user_id = $1", [userId]);
    if (!member.rows[0]) throw new ValidationError("userId", "That person is not on the team.");
    if (member.rows[0].role === "owner" && ctx.role !== "owner") throw new ValidationError("userId", "Only an owner can reset an owner's two-step verification.");
    await tx.query("select auth_totp_disable($1)", [userId]);
    await tx.query(
      `insert into audit_log (org_id, actor_type, actor_id, action, entity_type, entity_id, after) values ($1, 'user', $2, 'member.two_step_reset', 'user', $3, '{}')`,
      [ctx.orgId, ctx.userId, userId],
    );
  });
}

async function audit(ctx: Ctx, action: string, userId: string): Promise<void> {
  await withTenant(ctx.pool, ctx.orgId, async (tx) => {
    await tx.query(
      `insert into audit_log (org_id, actor_type, actor_id, action, entity_type, entity_id, after) values ($1, 'user', $2, $3, 'user', $4, '{}')`,
      [ctx.orgId, ctx.userId, action, userId],
    );
  });
}
