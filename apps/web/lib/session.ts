import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { currentMembership, type Ctx, type Membership } from "@bos/core";
import { pool } from "./pool";

const COOKIE = "bos_session";

/**
 * Development sign-in: an email with no password. It exists so the product can be
 * built and reviewed before a real identity provider is connected, and it is
 * refused in production unless DEV_SIGN_IN=1 is set on purpose.
 */
export function devSignInEnabled(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.DEV_SIGN_IN === "1";
}

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (value) return value;
  if (devSignInEnabled()) return "dev-only-session-secret";
  throw new Error("SESSION_SECRET is not set");
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export async function startSession(userId: string, orgId: string): Promise<void> {
  const payload = `${userId}.${orgId}`;
  (await cookies()).set(COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" && process.env.DEV_SIGN_IN !== "1",
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
