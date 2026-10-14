"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cancelDeal, createDeal, deliverDeal, ForbiddenError, recordDealPayment, StateError, updateDeal, ValidationError, type DealInput, type OdometerBrand } from "@bos/core";
import { requireSession } from "../../../lib/session";

const plain = (error: unknown): string =>
  error instanceof ValidationError || error instanceof StateError ? error.message : error instanceof ForbiddenError ? "You are not allowed to do that." : "Something went wrong. Try again.";
const text = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const num = (v: FormDataEntryValue | null) => {
  const t = text(v).replace(/[,$]/g, "");
  return t === "" ? undefined : Number(t);
};

function readDeal(form: FormData): DealInput {
  return {
    vehicleId: text(form.get("vehicleId")),
    customerId: text(form.get("customerId")) || null,
    buyerName: text(form.get("buyerName")),
    buyerAddress: text(form.get("buyerAddress")), buyerCity: text(form.get("buyerCity")), buyerState: text(form.get("buyerState")) || "FL", buyerZip: text(form.get("buyerZip")),
    buyerPhone: text(form.get("buyerPhone")), buyerEmail: text(form.get("buyerEmail")), buyerDl: text(form.get("buyerDl")), buyerDob: text(form.get("buyerDob")), buyerSex: text(form.get("buyerSex")), buyerCounty: text(form.get("buyerCounty")), coBuyerName: text(form.get("coBuyerName")),
    salePrice: num(form.get("salePrice")) ?? 0, dealerFee: num(form.get("dealerFee")), tradeAllowance: num(form.get("tradeAllowance")),
    tradeVin: text(form.get("tradeVin")), tradeDescription: text(form.get("tradeDescription")), tradeMileage: num(form.get("tradeMileage")),
    stateTaxPct: num(form.get("stateTaxPct")), surtaxPct: num(form.get("surtaxPct")), tagTitleFees: num(form.get("tagTitleFees")), otherFees: num(form.get("otherFees")), otherFeesNote: text(form.get("otherFeesNote")),
    odometer: num(form.get("odometer")), odometerBrand: (text(form.get("odometerBrand")) || "actual") as OdometerBrand,
    soldAsIs: form.get("soldAsIs") !== "no", warrantyNote: text(form.get("warrantyNote")), notes: text(form.get("notes")),
  };
}

export async function newDeal(form: FormData): Promise<void> {
  const { ctx } = await requireSession();
  let id: string;
  try {
    ({ id } = await createDeal(ctx, readDeal(form)));
  } catch (error) {
    redirect(`/deals/new?vehicle=${encodeURIComponent(text(form.get("vehicleId")))}&error=${encodeURIComponent(plain(error))}`);
  }
  revalidatePath("/deals");
  revalidatePath("/vehicles");
  redirect(`/deals/${id}?notice=${encodeURIComponent("Deal started. Record the payment, then deliver.")}`);
}

export async function saveDeal(id: string, form: FormData): Promise<void> {
  const { ctx } = await requireSession();
  try {
    await updateDeal(ctx, id, readDeal(form));
  } catch (error) {
    redirect(`/deals/${id}?error=${encodeURIComponent(plain(error))}`);
  }
  revalidatePath(`/deals/${id}`);
  redirect(`/deals/${id}?notice=${encodeURIComponent("Saved.")}`);
}

export async function takePayment(id: string, form: FormData): Promise<void> {
  const { ctx } = await requireSession();
  try {
    await recordDealPayment(ctx, id, { amount: num(form.get("amount")) ?? 0, method: text(form.get("method")), reference: text(form.get("reference")), paidOn: text(form.get("paidOn")) });
  } catch (error) {
    redirect(`/deals/${id}?error=${encodeURIComponent(plain(error))}`);
  }
  revalidatePath(`/deals/${id}`);
  redirect(`/deals/${id}?notice=${encodeURIComponent("Payment recorded.")}`);
}

export async function deliver(id: string, form: FormData): Promise<void> {
  const { ctx } = await requireSession();
  let trade: string | null = null;
  try {
    ({ tradeInId: trade } = await deliverDeal(ctx, id, text(form.get("deliveredOn"))));
  } catch (error) {
    redirect(`/deals/${id}?error=${encodeURIComponent(plain(error))}`);
  }
  revalidatePath("/deals");
  revalidatePath("/vehicles");
  revalidatePath("/");
  redirect(`/deals/${id}?notice=${encodeURIComponent(trade ? "Delivered. The trade-in is on the lot as a draft; decode its VIN when you can." : "Delivered. The vehicle is marked sold.")}`);
}

export async function cancel(id: string, form: FormData): Promise<void> {
  const { ctx } = await requireSession();
  try {
    await cancelDeal(ctx, id, text(form.get("reason")));
  } catch (error) {
    redirect(`/deals/${id}?error=${encodeURIComponent(plain(error))}`);
  }
  revalidatePath("/deals");
  revalidatePath("/vehicles");
  redirect(`/deals/${id}?notice=${encodeURIComponent("Deal cancelled. Any money taken is to be refunded by you.")}`);
}
