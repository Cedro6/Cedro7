import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "@bos/db/runtime";
import { ValidationError } from "./errors";
import { featuresFor, isBusinessType, type BusinessType } from "./features";
import { isCurrency, isTimeZone } from "./locale";
import { checkNewPassword, hashPassword, type SignedIn } from "./passwords";

/**
 * Joining the service. Whoever runs it hands out one-time sign-up links; the person who opens one
 * creates their company and becomes its owner. The company starts with only the tools that suit
 * its kind of business switched on, and nothing else in it.
 *
 * "Runs the service" is decided by the web app from its own configuration, not here: these
 * functions take that as given and must only be called for such a person.
 */
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const TOKEN = /^[A-Za-z0-9_-]{20,100}$/;

export async function createSignupLink(pool: Pool, createdBy: string, note: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const made = await pool.query<{ expires: Date }>("select signup_invite_create($1, $2, $3) as expires", [tokenHash(token), note.trim().slice(0, 200), createdBy]);
  return { token, expiresAt: made.rows[0]!.expires };
}

export async function signupLinkValid(pool: Pool, token: string): Promise<boolean> {
  if (!TOKEN.test(token)) return false;
  return Boolean((await pool.query<{ ok: boolean }>("select signup_invite_valid($1) as ok", [tokenHash(token)])).rows[0]?.ok);
}

export type SignupLink = { id: string; note: string; createdAt: Date; expiresAt: Date; state: "open" | "used" | "expired"; companyName: string | null };

export async function listSignupLinks(pool: Pool): Promise<SignupLink[]> {
  const r = await pool.query<{ id: string; note: string; created_at: Date; expires_at: Date; used_at: Date | null; org_name: string | null }>("select * from signup_invite_list()");
  return r.rows.map((row) => ({
    id: row.id, note: row.note, createdAt: row.created_at, expiresAt: row.expires_at, companyName: row.org_name,
    state: row.used_at ? "used" : row.expires_at > new Date() ? "open" : "expired",
  }));
}

/** Stops an unused link from working. */
export async function revokeSignupLink(pool: Pool, id: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  return Boolean((await pool.query<{ ok: boolean }>("select signup_invite_revoke($1) as ok", [id])).rows[0]?.ok);
}

export type PlatformCompany = { id: string; name: string; businessType: string; createdAt: Date; people: number; orders: number; lastActivity: Date | null; suspended: boolean };

export async function listCompanies(pool: Pool): Promise<PlatformCompany[]> {
  const r = await pool.query<{ id: string; name: string; business_type: string; created_at: Date; people: number; orders: number; last_activity: Date | null; suspended_at: Date | null }>("select * from platform_companies()");
  return r.rows.map((c) => ({ id: c.id, name: c.name, businessType: c.business_type, createdAt: c.created_at, people: c.people, orders: c.orders, lastActivity: c.last_activity, suspended: c.suspended_at !== null }));
}

/** Switches a company off or back on. While off, its people cannot sign in or use the app; nothing is deleted. */
export async function setCompanySuspended(pool: Pool, orgId: string, suspended: boolean): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(orgId)) return false;
  return Boolean((await pool.query<{ ok: boolean }>("select platform_set_suspended($1, $2) as ok", [orgId, suspended])).rows[0]?.ok);
}

/** Turns two-step verification off for the login with this email. For an owner who is locked out with nobody above them to ask. */
export async function platformResetTwoStep(pool: Pool, email: string): Promise<boolean> {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return false;
  return Boolean((await pool.query<{ ok: boolean }>("select platform_reset_two_step($1) as ok", [email])).rows[0]?.ok);
}

export type SignupInput = {
  company: string;
  businessType: string;
  timeZone: string;
  currency: string;
  /** The tax usually charged, as a percentage. */
  taxPercent: number;
  name: string;
  email: string;
  password: string;
};

/** Checks everything a person typed, so the form can say what to fix before anything is created. */
export function checkSignup(input: SignupInput): { company: string; businessType: BusinessType; name: string; email: string } {
  const company = input.company.trim();
  if (!company) throw new ValidationError("company", "Enter your company's name.");
  if (company.length > 200) throw new ValidationError("company", "Keep the company name under 200 characters.");
  if (!isBusinessType(input.businessType)) throw new ValidationError("businessType", "Choose the kind of business.");
  if (!isTimeZone(input.timeZone)) throw new ValidationError("timeZone", "Choose a time zone from the list.");
  if (!isCurrency(input.currency)) throw new ValidationError("currency", "Choose a currency from the list.");
  const tax = input.taxPercent;
  if (!Number.isFinite(tax) || tax < 0 || tax >= 100 || Math.round(tax * 1000) / 1000 !== tax) throw new ValidationError("taxPercent", "Tax must be between 0 and 100 percent, with at most 3 decimal places.");
  const name = input.name.trim();
  if (!name || name.length > 120) throw new ValidationError("name", "Enter your name.");
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw new ValidationError("email", "Enter a valid email address.");
  checkNewPassword(input.password, email);
  return { company, businessType: input.businessType, name, email };
}

/** Creates the company and its owner from a sign-up link. The link works once. */
export async function signUp(pool: Pool, token: string, input: SignupInput): Promise<SignedIn> {
  const gone = new ValidationError("token", "This sign-up link has been used or has expired. Ask for a new one.");
  if (!(await signupLinkValid(pool, token))) throw gone;
  const clean = checkSignup(input);
  const slug = clean.company.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 58);
  try {
    const made = await pool.query<{ user_id: string; org_id: string; session_version: number }>(
      "select * from signup_create_company($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11)",
      [
        tokenHash(token), clean.company, slug.length >= 2 ? slug : `company-${randomBytes(4).toString("hex")}`, clean.businessType,
        JSON.stringify(featuresFor(clean.businessType)), input.timeZone, input.currency, input.taxPercent, clean.name, clean.email, await hashPassword(input.password),
      ],
    );
    const row = made.rows[0];
    if (!row) throw gone;
    return { userId: row.user_id, orgId: row.org_id, sessionVersion: row.session_version, twoStep: false };
  } catch (error) {
    if (error instanceof Error && error.message.includes("email_taken")) {
      throw new ValidationError("email", "That email already has a login here. Sign in with it, or use a different email for this company.");
    }
    throw error;
  }
}
