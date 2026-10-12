"use server";

import { redirect } from "next/navigation";
import { changeOwnPassword, ValidationError } from "@bos/core";
import { requireSession, startSession } from "../../../lib/session";

export async function changePassword(form: FormData): Promise<void> {
  const { ctx } = await requireSession();
  const next = String(form.get("next") ?? "");
  let message = "";
  if (next !== String(form.get("again") ?? "")) message = "The two new passwords do not match.";
  else {
    try {
      const { sessionVersion } = await changeOwnPassword(ctx, { current: String(form.get("current") ?? ""), next });
      // This device carries on with the new version; every other session is now signed out.
      await startSession(ctx.userId, ctx.orgId, sessionVersion);
    } catch (error) {
      if (error instanceof ValidationError) message = error.message;
      else throw error;
    }
  }
  redirect(message ? `/account?error=${encodeURIComponent(message)}` : `/account?notice=${encodeURIComponent("Password changed. Anywhere else you were signed in has been signed out.")}`);
}
