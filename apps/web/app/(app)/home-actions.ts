"use server";

import { redirect } from "next/navigation";
import { changeHomeLayout, ValidationError, type HomeChange } from "@bos/core";
import { requireSession } from "../../lib/session";

/** Arranges the signed-in person's own Home screen, then returns to it in Customize mode. */
export async function changeHome(form: FormData): Promise<void> {
  const { ctx, membership } = await requireSession();
  const kind = String(form.get("kind") ?? "");
  const id = String(form.get("id") ?? "");
  const change: HomeChange | null =
    kind === "add" ? { kind, id }
    : kind === "remove" ? { kind, id }
    : kind === "move" ? { kind, id, by: form.get("by") === "-1" ? -1 : 1 }
    : kind === "replace" ? { kind, id, with: String(form.get("with") ?? "") }
    : kind === "reset" ? { kind }
    : null;
  let error = "";
  if (change) {
    try {
      await changeHomeLayout(ctx, membership.businessType, change);
    } catch (e) {
      if (e instanceof ValidationError) error = e.message;
      else throw e;
    }
  }
  redirect(`/?edit=1${error ? `&error=${encodeURIComponent(error)}` : ""}`);
}
