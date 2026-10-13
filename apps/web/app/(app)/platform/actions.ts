"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createSignupLink, platformResetTwoStep, revokeSignupLink, setCompanySuspended } from "@bos/core";
import { isPlatformAdmin } from "../../../lib/platform";
import { pool } from "../../../lib/pool";
import { requireSession } from "../../../lib/session";

export type LinkState = { error: string; link: string; note: string };

async function admin() {
  const session = await requireSession();
  if (!isPlatformAdmin(session.membership.userEmail)) throw new Error("Not allowed");
  return session;
}

/** Makes a one-time sign-up link. It is shown once, to pass on to the new company's owner. */
export async function makeLink(_previous: LinkState, form: FormData): Promise<LinkState> {
  const { ctx } = await admin();
  const note = String(form.get("note") ?? "").trim();
  if (!note) return { error: "Say who the link is for, so you can tell them apart later.", link: "", note: "" };
  const made = await createSignupLink(pool, ctx.userId, note);
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  revalidatePath("/platform");
  return { error: "", link: `${proto}://${host}/sign-up?token=${made.token}`, note };
}

export async function cancelLink(form: FormData): Promise<void> {
  await admin();
  await revokeSignupLink(pool, String(form.get("id") ?? ""));
  revalidatePath("/platform");
}

export async function suspendCompany(form: FormData): Promise<void> {
  const { ctx } = await admin();
  const orgId = String(form.get("orgId") ?? "");
  const suspend = form.get("suspend") === "1";
  // Suspending the company you are signed in to would lock you out of this screen.
  if (suspend && orgId === ctx.orgId) redirect(`/platform?error=${encodeURIComponent("That is the company you are signed in to. Suspending it would lock you out.")}`);
  await setCompanySuspended(pool, orgId, suspend);
  revalidatePath("/platform");
  redirect(`/platform?notice=${encodeURIComponent(suspend ? "Suspended. Its people can no longer sign in. Nothing was deleted." : "Switched back on.")}`);
}

export async function resetOwnerTwoStep(form: FormData): Promise<void> {
  await admin();
  const email = String(form.get("email") ?? "").trim();
  const done = await platformResetTwoStep(pool, email);
  redirect(`/platform?${done ? "notice" : "error"}=${encodeURIComponent(done ? `Two-step verification is off for ${email}. They sign in with their password and can set it up again.` : "No login with that email has two-step verification on.")}`);
}
