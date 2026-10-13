"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createPasswordLink, ForbiddenError, inviteMember, resetMemberTwoStep, updateMember, ValidationError } from "@bos/core";
import { requireSession } from "../../../lib/session";

export type TeamState = { error: string; notice: string; link: string; linkFor: string };
const blank: TeamState = { error: "", notice: "", link: "", linkFor: "" };

function refused(error: unknown): TeamState {
  if (error instanceof ValidationError) return { ...blank, error: error.message };
  if (error instanceof ForbiddenError) return { ...blank, error: "Only an owner or admin can manage the team." };
  throw error;
}

/** The address of this site as the person is using it, so the link works wherever the app is hosted. */
async function linkTo(token: string): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}/set-password?token=${token}`;
}

export async function invite(_previous: TeamState, form: FormData): Promise<TeamState> {
  const { ctx } = await requireSession();
  const name = String(form.get("name") ?? "");
  try {
    const made = await inviteMember(ctx, { name, email: String(form.get("email") ?? ""), role: String(form.get("role") ?? "") });
    revalidatePath("/settings");
    return { ...blank, notice: `${name.trim()} added. Send them the link below to set their password. It works for 7 days.`, link: await linkTo(made.token), linkFor: name.trim() };
  } catch (error) {
    return refused(error);
  }
}

export async function newLink(_previous: TeamState, form: FormData): Promise<TeamState> {
  const { ctx } = await requireSession();
  const name = String(form.get("name") ?? "them");
  try {
    const made = await createPasswordLink(ctx, String(form.get("userId") ?? ""));
    return { ...blank, notice: "New link made. It works for 1 hour, and any earlier link for this person has stopped working.", link: await linkTo(made.token), linkFor: name };
  } catch (error) {
    return refused(error);
  }
}

export async function changeMember(_previous: TeamState, form: FormData): Promise<TeamState> {
  const { ctx } = await requireSession();
  const status = form.get("status");
  try {
    if (form.get("resetTwoStep") === "1") {
      await resetMemberTwoStep(ctx, String(form.get("userId") ?? ""));
      revalidatePath("/settings");
      return { ...blank, notice: "Two-step verification is off for them. They sign in with just their password until they set it up again." };
    }
    await updateMember(ctx, String(form.get("userId") ?? ""), status ? { status: String(status) } : { role: String(form.get("role") ?? "") });
    revalidatePath("/", "layout");
    return { ...blank, notice: status === "suspended" ? "Suspended. They can no longer sign in." : status ? "Reactivated." : "Role saved." };
  } catch (error) {
    return refused(error);
  }
}
