import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { currentMembership, type Ctx, type Membership } from "@bos/core";
import { pool } from "./pool";

const COOKIE = "bos_session";

const inProduction = (): boolean => process.env.NODE_ENV === "production";

/**
 * Development sign-in: choose a person by email, with no personal password. It
 * exists so the product can be built and reviewed before a real identity
 * provider is connected.
 *
 * On a deployed copy it is off unless DEV_SIGN_IN=1 is set, and then it also
 * needs PREVIEW_PASSWORD: one shared password, so a preview on the internet is
 * not open to anyone who finds the address.
 */
export function devSignInEnabled(): boolean {
  if (!inProduction()) return true;
  return process.env.DEV_SIGN_IN === "1" && Boolean(process.env.PREVIEW_PASSWORD);
}

/** True when sign-in must also present the shared preview password. */
export function previewPasswordRequired(): boolean {
  return inProduction();
}

export function previewPasswordMatches(given: string): boolean {
  const expected = process.env.PREVIEW_PASSWORD ?? "";
  if (!expected) return false;
  const a = createHmac("sha256", "preview").update(given).digest();
  const b = createHmac("sha256", "preview").update(expected).digest();
  return timingSafeEqual(a, b);
}

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (value && value.length >= 32) return value;
  // A deployed copy must sign sessions with its own secret, or cookies could be forged.
  if (inProduction()) throw new Error("SESSION_SECRET must be set to at least 32 characters");
  return "dev-only-session-secret";
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export async function startSession(userId: string, orgId: string): Promise<void> {
  const payload = `${userId}.${orgId}`;
  (await cookies()).set(COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: inProduction() && process.env.INSECURE_COOKIES !== "1",
    path: "/",
    maxAge: 60 * 60 * 12,
  });
}

export async function endSession(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

export type Session = { ctx: Ctx; membership: Membership };

/** The signed-in person and their company, or a redirect to sign-in. */
export async function requireSession(): Promise<Session> {
  const raw = (await cookies()).get(COOKIE)?.value;
  const [userId, orgId, signature] = raw?.split(".") ?? [];
  if (!userId || !orgId || !signature) redirect("/sign-in");
  const expected = Buffer.from(sign(`${userId}.${orgId}`));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) redirect("/sign-in");
  const membership = await currentMembership(pool, orgId, userId).catch(() => null);
  if (!membership) redirect("/sign-in");
  return { ctx: { pool, orgId, userId, role: membership.role }, membership };
}
