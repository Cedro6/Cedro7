"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { FEATURES, ForbiddenError, MAX_LOGO_LENGTH, setCompanyLogo, setRequireTwoStep, updateCompanyProfile, updateRegion, isBusinessType, isFeature, setBusinessType, setFeature, StateError, TYPE_FEATURES, ValidationError , updateDealerSettings } from "@bos/core";
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
      ? `notice=${encodeURIComponent(`Set up for ${TYPE_TEXT[type].name.toLowerCase()}. ${TYPE_FEATURES[type].length} of ${FEATURES.length} tools are on.`)}`
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

const field = (form: FormData, key: string) => String(form.get(key) ?? "");

export async function saveCompany(form: FormData): Promise<void> {
  const { ctx } = await requireSession();
  let query: string;
  try {
    await updateCompanyProfile(ctx, {
      name: field(form, "name"),
      address: field(form, "address"),
      phone: field(form, "phone"),
      email: field(form, "email"),
      taxNumber: field(form, "taxNumber"),
      invoiceFooter: field(form, "invoiceFooter"),
    });
    query = `notice=${encodeURIComponent("Company details saved.")}`;
  } catch (error) {
    query = `error=${encodeURIComponent(friendly(error))}`;
  }
  revalidatePath("/", "layout");
  redirect(`/settings?${query}`);
}

export async function saveLogo(form: FormData): Promise<void> {
  const { ctx } = await requireSession();
  let query: string;
  try {
    if (form.get("remove") === "1") {
      await setCompanyLogo(ctx, null);
      query = `notice=${encodeURIComponent("Logo removed.")}`;
    } else {
      const file = form.get("logo");
      if (!(file instanceof File) || file.size === 0) throw new ValidationError("logo", "Choose an image file first.");
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new ValidationError("logo", "Use a PNG, JPEG or WebP image.");
      // Checked before reading the file, so a huge upload is turned away early.
      if (file.size > (MAX_LOGO_LENGTH * 3) / 4 - 100) throw new ValidationError("logo", "That image is too large. Use one under 200 KB.");
      const data = Buffer.from(await file.arrayBuffer()).toString("base64");
      await setCompanyLogo(ctx, `data:${file.type};base64,${data}`);
      query = `notice=${encodeURIComponent("Logo saved. It now prints on your invoices.")}`;
    }
  } catch (error) {
    query = `error=${encodeURIComponent(friendly(error))}`;
  }
  revalidatePath("/", "layout");
  redirect(`/settings?${query}`);
}

export async function saveDealer(form: FormData): Promise<void> {
  const { ctx } = await requireSession();
  let query: string;
  try {
    const n = (k: string) => { const t = field(form, k).trim().replace(/[,$%]/g, ""); return t === "" ? 0 : Number(t); };
    await updateDealerSettings(ctx, {
      licence: field(form, "licence"), county: field(form, "county"), surtaxPct: n("surtaxPct"), dealerFee: n("dealerFee"), tagTitleFees: n("tagTitleFees"),
      stockNumberStyle: field(form, "stockNumberStyle") === "vin6" ? "vin6" : "counter", stockNumberPrefix: field(form, "stockNumberPrefix"),
    });
    query = `notice=${encodeURIComponent("Dealer settings saved.")}`;
  } catch (error) {
    query = `error=${encodeURIComponent(friendly(error))}`;
  }
  revalidatePath("/", "layout");
  redirect(`/settings?${query}`);
}

export async function saveRegion(form: FormData): Promise<void> {
  const { ctx } = await requireSession();
  let query: string;
  try {
    const tax = field(form, "defaultTaxPercent").trim();
    await updateRegion(ctx, { timeZone: field(form, "timeZone"), currency: field(form, "currency"), defaultTaxPercent: tax === "" ? 0 : Number(tax) });
    query = `notice=${encodeURIComponent("Region and tax saved.")}`;
  } catch (error) {
    query = `error=${encodeURIComponent(friendly(error))}`;
  }
  revalidatePath("/", "layout");
  redirect(`/settings?${query}`);
}

export async function saveTwoStepRule(form: FormData): Promise<void> {
  const { ctx } = await requireSession();
  const on = form.get("requireTwoStep") === "1";
  let query: string;
  try {
    await setRequireTwoStep(ctx, on);
    query = `notice=${encodeURIComponent(on ? "Two-step verification is now required for everyone with a password." : "Two-step verification is optional again.")}`;
  } catch (error) {
    query = `error=${encodeURIComponent(friendly(error))}`;
  }
  revalidatePath("/", "layout");
  redirect(`/settings?${query}`);
}
