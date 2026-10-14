"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { beginTwoStep, changeOwnPassword, confirmTwoStep, disableTwoStep, ValidationError } from "@bos/core";
import { requireSession, startSession } from "../../../lib/session";

export async function changePassword(form: FormData): Promise<void> {
  const { ctx } = await requireSession({ setupAllowed: true, billingAllowed: true });
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

const ISSUER = "Cedro Terminal";

export async function startSetup(): Promise<void> {
  const { ctx } = await requireSession({ setupAllowed: true, billingAllowed: true });
  let message = "";
  try {
    await beginTwoStep(ctx, ISSUER);
  } catch (error) {
    if (error instanceof ValidationError) message = error.message;
    else throw error;
  }
  revalidatePath("/account");
  redirect(message ? `/account?error=${encodeURIComponent(message)}` : "/account?setup=1#two-step");
}

export type SetupState = { error: string; codes: string[] };

/** Checks the first code. On success the recovery codes go straight back to the page, never into an address. */
export async function confirmSetup(_previous: SetupState, form: FormData): Promise<SetupState> {
  const { ctx } = await requireSession({ setupAllowed: true, billingAllowed: true });
  try {
    const { recoveryCodes } = await confirmTwoStep(ctx, String(form.get("code") ?? ""));
    return { error: "", codes: recoveryCodes };
  } catch (error) {
    if (error instanceof ValidationError) return { error: error.message, codes: [] };
    throw error;
  }
}

export async function turnOffTwoStep(form: FormData): Promise<void> {
  const { ctx } = await requireSession({ setupAllowed: true, billingAllowed: true });
  let message = "";
  try {
    await disableTwoStep(ctx, { password: String(form.get("password") ?? ""), code: String(form.get("code") ?? "") });
  } catch (error) {
    if (error instanceof ValidationError) message = error.message;
    else throw error;
  }
  redirect(message ? `/account?error=${encodeURIComponent(message)}` : `/account?notice=${encodeURIComponent("Two-step verification is off.")}`);
}
