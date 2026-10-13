"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createSignupLink, revokeSignupLink } from "@bos/core";
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
