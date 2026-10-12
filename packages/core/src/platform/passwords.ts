import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { Pool } from "@bos/db/runtime";
import { withTenant } from "@bos/db/runtime";
import type { Ctx } from "./context";
import { ValidationError } from "./errors";
import { isRole, requirePermission, type Role } from "./permissions";

const N = 32768;
const R = 8;
const P = 1;
const KEY = 64;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize("NFKC"), salt, KEY, { N: n, r, p, maxmem: 128 * n * r * 2 }, (error, key) => (error ? reject(error) : resolve(key))),
  );
}

/** A salted scrypt hash, stored with its parameters so they can be raised later without breaking old passwords. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const given = await derive(password, Buffer.from(salt, "base64"), Number(n), Number(r), Number(p)).catch(() => null);
  return given !== null && given.length === expected.length && timingSafeEqual(given, expected);
}

/** Rules a person can meet without a password manager, while ruling out the obvious. */
export function checkNewPassword(password: string, email: string): void {
  if (password.length < 10) throw new ValidationError("password", "Use at least 10 characters.");
  if (password.length > 200) throw new ValidationError("password", "Keep the password under 200 characters.");
  const lower = password.toLowerCase();
  if (lower === email.toLowerCase() || lower.includes(email.split("@")[0]!.toLowerCase())) {
    throw new ValidationError("password", "Do not use your email address in the password.");
  }
  if (/^(.)\1+$/.test(password) || ["password12", "1234567890", "qwertyuiop"].some((weak) => lower.startsWith(weak))) {
    throw new ValidationError("password", "That password is too easy to guess.");
  }
}

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
// Checked against when the email is unknown, so an unknown email takes as long to refuse as a wrong password.
let decoy: Promise<string> | null = null;

export type SignedIn = { userId: string; orgId: string; sessionVersion: number };
export type SignInResult = { ok: true; session: SignedIn } | { ok: false; reason: "wrong" | "locked" };

/**
 * Checks an email and password. The answer never says which of the two was wrong. Five wrong
 * passwords in a row lock the account for 15 minutes.
 */
export async function signInWithPassword(pool: Pool, email: string, password: string): Promise<SignInResult> {
  const found = await pool.query<{ user_id: string; password_hash: string; locked: boolean; session_version: number }>(
    "select * from auth_credential($1)",
    [email.slice(0, 320)],
  );
  const row = found.rows[0];
  if (!row) {
    await verifyPassword(password, await (decoy ??= hashPassword("not-a-real-password")));
    return { ok: false, reason: "wrong" };
  }
  if (row.locked) return { ok: false, reason: "locked" };
  const ok = await verifyPassword(password.slice(0, 200), row.password_hash);
  await pool.query("select auth_record_attempt($1, $2)", [row.user_id, ok]);
  if (!ok) return { ok: false, reason: "wrong" };
  const org = await pool.query<{ org_id: string }>("select org_id from auth_memberships_by_email($1) limit 1", [email]);
  if (!org.rows[0]) return { ok: false, reason: "wrong" };
  return { ok: true, session: { userId: row.user_id, orgId: org.rows[0].org_id, sessionVersion: row.session_version } };
}

export async function sessionVersion(pool: Pool, userId: string): Promise<number> {
  const result = await pool.query<{ v: number }>("select auth_session_version($1) as v", [userId]);
  return result.rows[0]?.v ?? 0;
}

export type LinkOwner = { email: string; name: string; orgName: string; purpose: "invite" | "reset" };

/** Who a set-password link is for, or null if it is used, expired or made up. */
export async function passwordLinkOwner(pool: Pool, token: string): Promise<LinkOwner | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const result = await pool.query<{ email: string; name: string; org_name: string; purpose: "invite" | "reset" }>(
    "select email, name, org_name, purpose from auth_token_owner($1)",
    [tokenHash(token)],
  );
  const row = result.rows[0];
  return row ? { email: row.email, name: row.name, orgName: row.org_name, purpose: row.purpose } : null;
}

/** Sets the password from a one-time link and returns who to sign in as. The link works once. */
export async function setPasswordWithLink(pool: Pool, token: string, password: string): Promise<SignedIn> {
  const owner = await passwordLinkOwner(pool, token);
  if (!owner) throw new ValidationError("token", "This link has been used or has expired. Ask for a new one.");
  checkNewPassword(password, owner.email);
  const result = await pool.query<{ user_id: string; org_id: string; session_version: number }>(
    "select * from auth_set_password($1, $2)",
    [tokenHash(token), await hashPassword(password)],
  );
  const row = result.rows[0];
  if (!row) throw new ValidationError("token", "This link has been used or has expired. Ask for a new one.");
  return { userId: row.user_id, orgId: row.org_id, sessionVersion: row.session_version };
}

export type TeamMemberDetail = { userId: string; name: string; email: string; role: Role; status: "active" | "suspended"; hasPassword: boolean; isYou: boolean };

export async function listMembers(ctx: Ctx): Promise<TeamMemberDetail[]> {
  requirePermission(ctx, "settings.manage");
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const members = await tx.query<{ userId: string; name: string; email: string; role: string; status: "active" | "suspended" }>(
      `select u.id as "userId", u.name, u.email, m.role, m.status from memberships m join users u on u.id = m.user_id order by m.status, lower(u.name)`,
    );
    const withPassword = await tx.query<{ user_id: string }>("select user_id from auth_has_password($1::uuid[])", [members.rows.map((m) => m.userId)]);
    const set = new Set(withPassword.rows.map((r) => r.user_id));
    return members.rows.flatMap((m) => (isRole(m.role) ? [{ ...m, role: m.role, hasPassword: set.has(m.userId), isYou: m.userId === ctx.userId }] : []));
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function issueLink(tx: { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> }, ctx: Ctx, userId: string, purpose: "invite" | "reset") {
  const token = randomBytes(32).toString("base64url");
  const issued = (await tx.query("select auth_issue_token($1, $2, $3, $4, $5) as expires", [ctx.orgId, userId, purpose, tokenHash(token), ctx.userId])) as { rows: { expires: Date }[] };
  return { token, expiresAt: issued.rows[0]!.expires };
}

/** Adds a person to the company and returns a one-time link for them to set their password. */
export async function inviteMember(ctx: Ctx, input: { name: string; email: string; role: string }): Promise<{ userId: string; token: string; expiresAt: Date }> {
  requirePermission(ctx, "settings.manage");
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  if (!name || name.length > 120) throw new ValidationError("name", "Enter the person's name.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw new ValidationError("email", "Enter a valid email address.");
  if (!isRole(input.role)) throw new ValidationError("role", "Choose a role.");
  if (input.role === "owner" && ctx.role !== "owner") throw new ValidationError("role", "Only an owner can add another owner.");
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const user = await tx.query<{ id: string }>("select auth_upsert_user($1, $2) as id", [email, name]);
    const userId = user.rows[0]!.id;
    const existing = await tx.query("select 1 from memberships where user_id = $1", [userId]);
    if (existing.rowCount) throw new ValidationError("email", "That person is already on the team.");
    await tx.query("insert into memberships (org_id, user_id, role) values ($1, $2, $3)", [ctx.orgId, userId, input.role]);
    await tx.query(
      `insert into audit_log (org_id, actor_type, actor_id, action, entity_type, entity_id, after)
       values ($1, 'user', $2, 'member.invited', 'user', $3, $4)`,
      [ctx.orgId, ctx.userId, userId, JSON.stringify({ email, role: input.role })],
    );
    return { userId, ...(await issueLink(tx, ctx, userId, "invite")) };
  });
}

/** A fresh one-time link for someone already on the team, to set or replace their password. */
export async function createPasswordLink(ctx: Ctx, userId: string): Promise<{ token: string; expiresAt: Date }> {
  requirePermission(ctx, "settings.manage");
  if (!UUID.test(userId)) throw new ValidationError("userId", "That person was not found.");
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const member = await tx.query<{ role: string }>("select role from memberships where user_id = $1 and status = 'active'", [userId]);
    if (!member.rows[0]) throw new ValidationError("userId", "That person is not an active member of the team.");
    if (member.rows[0].role === "owner" && ctx.role !== "owner") throw new ValidationError("userId", "Only an owner can reset an owner's password.");
    await tx.query(
      `insert into audit_log (org_id, actor_type, actor_id, action, entity_type, entity_id, after)
       values ($1, 'user', $2, 'member.password_link', 'user', $3, '{}')`,
      [ctx.orgId, ctx.userId, userId],
    );
    return issueLink(tx, ctx, userId, "reset");
  });
}

/** Changes a member's role or suspends them. The company always keeps at least one active owner. */
export async function updateMember(ctx: Ctx, userId: string, change: { role?: string; status?: string }): Promise<void> {
  requirePermission(ctx, "settings.manage");
  if (!UUID.test(userId)) throw new ValidationError("userId", "That person was not found.");
  if (change.role !== undefined && !isRole(change.role)) throw new ValidationError("role", "Choose a role.");
  if (change.status !== undefined && change.status !== "active" && change.status !== "suspended") throw new ValidationError("status", "Choose active or suspended.");
  await withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const all = await tx.query<{ user_id: string; role: string; status: string }>("select user_id, role, status from memberships for update");
    const target = all.rows.find((m) => m.user_id === userId);
    if (!target) throw new ValidationError("userId", "That person was not found.");
    const role = change.role ?? target.role;
    const status = change.status ?? target.status;
    if ((target.role === "owner" || role === "owner") && ctx.role !== "owner") throw new ValidationError("role", "Only an owner can change an owner.");
    if (userId === ctx.userId && status === "suspended") throw new ValidationError("status", "You cannot suspend yourself.");
    const ownersLeft = all.rows.filter((m) => (m.user_id === userId ? role === "owner" && status === "active" : m.role === "owner" && m.status === "active")).length;
    if (ownersLeft === 0) throw new ValidationError("role", "The company needs at least one active owner.");
    await tx.query("update memberships set role = $2, status = $3, updated_at = now() where user_id = $1", [userId, role, status]);
    await tx.query(
      `insert into audit_log (org_id, actor_type, actor_id, action, entity_type, entity_id, before, after)
       values ($1, 'user', $2, 'member.updated', 'user', $3, $4, $5)`,
      [ctx.orgId, ctx.userId, userId, JSON.stringify({ role: target.role, status: target.status }), JSON.stringify({ role, status })],
    );
  });
}
