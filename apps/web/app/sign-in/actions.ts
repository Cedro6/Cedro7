"use server";

import { redirect } from "next/navigation";
import { membershipsByEmail } from "@bos/core";
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
  await startSession(first.userId, first.orgId);
  redirect("/");
}
