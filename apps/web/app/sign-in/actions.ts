"use server";

import { redirect } from "next/navigation";
import { membershipsByEmail, sessionVersion, signInWithPassword } from "@bos/core";
import { pool } from "../../lib/pool";
import { devSignInEnabled, previewPasswordMatches, previewPasswordRequired, startSession } from "../../lib/session";

export async function signIn(formData: FormData): Promise<void> {
  if (!devSignInEnabled()) redirect("/sign-in?error=disabled");
  if (previewPasswordRequired() && !previewPasswordMatches(String(formData.get("previewPassword") ?? ""))) {
    // A short pause makes guessing the shared password slow.
    await new Promise((resolve) => setTimeout(resolve, 800));
    redirect("/sign-in?error=password");
  }
  const email = String(formData.get("email") ?? "");
  const memberships = await membershipsByEmail(pool, email);
  const first = memberships[0];
  if (!first) redirect("/sign-in?error=unknown");
  // A demo person who has since been given a password must use it.
  if ((await sessionVersion(pool, first.userId)) !== 0) redirect("/sign-in?error=has-password");
  await startSession(first.userId, first.orgId);
  redirect("/");
}

/** Personal sign-in with an email and password. */
export async function signInWithEmail(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) redirect("/sign-in?error=wrong");
  const result = await signInWithPassword(pool, email, password);
  if (!result.ok) redirect(`/sign-in?error=${result.reason}`);
  await startSession(result.session.userId, result.session.orgId, result.session.sessionVersion);
  redirect("/");
}
