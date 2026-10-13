"use server";

import { redirect } from "next/navigation";
import { membershipsByEmail, sessionVersion, signInWithPassword, verifyTwoStep } from "@bos/core";
import { pool } from "../../lib/pool";
import { clearPending, devSignInEnabled, previewPasswordMatches, previewPasswordRequired, readPending, startPending, startSession } from "../../lib/session";

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
  if (result.session.twoStep) {
    await startPending(result.session.userId, result.session.orgId, result.session.sessionVersion);
    redirect("/sign-in/verify");
  }
  await startSession(result.session.userId, result.session.orgId, result.session.sessionVersion);
  redirect("/");
}

/** The second step: the code from the person's authenticator app, or one of their recovery codes. */
export async function verifyCode(formData: FormData): Promise<void> {
  const pending = await readPending();
  if (!pending) redirect("/sign-in?error=expired");
  const result = await verifyTwoStep(pool, pending.userId, String(formData.get("code") ?? ""));
  if (!result.ok) {
    if (result.reason === "locked") {
      await clearPending();
      redirect("/sign-in?error=locked");
    }
    redirect("/sign-in/verify?error=wrong");
  }
  // The password may have been changed while this screen was open; only the current version signs in.
  if ((await sessionVersion(pool, pending.userId)) !== pending.version) {
    await clearPending();
    redirect("/sign-in?error=expired");
  }
  await clearPending();
  await startSession(pending.userId, pending.orgId, pending.version);
  redirect(result.usedRecovery ? `/account?notice=${encodeURIComponent(`You signed in with a recovery code. ${result.recoveryLeft} left. If you have lost your phone, turn two-step verification off below and set it up again.`)}` : "/");
}
