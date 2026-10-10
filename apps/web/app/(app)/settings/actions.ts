"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ForbiddenError, isBusinessType, isFeature, setBusinessType, setFeature, StateError, TYPE_FEATURES, ValidationError } from "@bos/core";
import { FEATURE_TEXT, TYPE_TEXT } from "../../../lib/features";
import { requireSession } from "../../../lib/session";

function friendly(error: unknown): string {
  if (error instanceof ValidationError || error instanceof StateError) return error.message;
  if (error instanceof ForbiddenError) return "Only an owner or admin can change these.";
  throw error;
}

export async function chooseType(formData: FormData): Promise<void> {
  const { ctx } = await requireSession();
  const type = String(formData.get("businessType") ?? "");
  let query: string;
  try {
    await setBusinessType(ctx, type);
    query = isBusinessType(type)
      ? `notice=${encodeURIComponent(`Set up for ${TYPE_TEXT[type].name.toLowerCase()}. ${TYPE_FEATURES[type].length} of 11 tools are on.`)}`
      : "";
  } catch (error) {
    query = `error=${encodeURIComponent(friendly(error))}`;
  }
  // The side menu depends on these switches, so every screen is rebuilt, not only this one.
  revalidatePath("/", "layout");
  redirect(`/settings?${query}`);
}

export async function switchFeature(formData: FormData): Promise<void> {
  const { ctx } = await requireSession();
  const feature = String(formData.get("feature") ?? "");
  const on = formData.get("on") === "1";
  let query: string;
  try {
    await setFeature(ctx, feature, on);
    const name = isFeature(feature) ? FEATURE_TEXT[feature].name : "Feature";
    query = `notice=${encodeURIComponent(
      feature === "stock" && on
        ? "Stock and shipping turned on. Count your stock before relying on the numbers."
        : `${name} turned ${on ? "on" : "off"}.`,
    )}`;
  } catch (error) {
    query = `error=${encodeURIComponent(friendly(error))}`;
  }
  // The side menu depends on these switches, so every screen is rebuilt, not only this one.
  revalidatePath("/", "layout");
  redirect(`/settings?${query}`);
}
