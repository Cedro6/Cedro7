"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  addVehicleCost, createVehicle, ForbiddenError, isVehicleStatus, makeCoverPhoto, removeVehicleCost, lookupVin, planVehicleImport, runVehicleImport, StateError, updateVehicle, ValidationError,
  type VehicleImportRow, type VehicleOwnInput, type VehicleSpecs, type VinLookup,
} from "@bos/core";
import { requireSession } from "../../../lib/session";

const plain = (error: unknown): string =>
  error instanceof ValidationError || error instanceof StateError ? error.message : error instanceof ForbiddenError ? "You are not allowed to do that." : "Something went wrong. Try again.";

export type LookupResult = { ok: true; lookup: VinLookup } | { ok: false; error: string };

/** Checks and decodes a VIN. Nothing is saved. */
export async function lookupVinAction(vin: string): Promise<LookupResult> {
  const { ctx } = await requireSession();
  try {
    return { ok: true, lookup: await lookupVin(ctx, String(vin ?? "")) };
  } catch (error) {
    if (!(error instanceof ValidationError || error instanceof StateError || error instanceof ForbiddenError)) console.error("vehicles: lookup failed", error);
    return { ok: false, error: plain(error) };
  }
}

const num = (v: FormDataEntryValue | null) => {
  const t = String(v ?? "").trim().replace(/[,$]/g, "");
  return t === "" ? undefined : Number(t);
};
const text = (v: FormDataEntryValue | null) => String(v ?? "").trim();

function readSpecs(form: FormData): Partial<VehicleSpecs> {
  return {
    year: num(form.get("year")), make: text(form.get("make")), model: text(form.get("model")), trim: text(form.get("trim")), bodyStyle: text(form.get("bodyStyle")),
    engine: text(form.get("engine")), displacementL: num(form.get("displacementL")), cylinders: num(form.get("cylinders")), horsepower: num(form.get("horsepower")),
    transmission: text(form.get("transmission")), drivetrain: text(form.get("drivetrain")), fuelType: text(form.get("fuelType")), category: text(form.get("category")),
    manufacturer: text(form.get("manufacturer")), doors: num(form.get("doors")), cab: text(form.get("cab")), bedLength: text(form.get("bedLength")), madeIn: text(form.get("madeIn")),
  };
}
function readOwn(form: FormData): VehicleOwnInput {
  const status = text(form.get("status"));
  return {
    colour: text(form.get("colour")), mileage: num(form.get("mileage")), condition: text(form.get("condition")),
    acquisitionPrice: num(form.get("acquisitionPrice")), acquisitionSource: text(form.get("acquisitionSource")), acquiredOn: text(form.get("acquiredOn")),
    askingPrice: num(form.get("askingPrice")), ...(isVehicleStatus(status) ? { status } : {}), notes: text(form.get("notes")), description: text(form.get("description")),
    titleNumber: text(form.get("titleNumber")), titleState: text(form.get("titleState")) || "FL", titleIssuedOn: text(form.get("titleIssuedOn")),
  };
}

export type SaveResult = { ok: true; id: string; stockNumber: string } | { ok: false; error: string };

/** Creates the record from the review form. */
export async function saveNewVehicle(form: FormData): Promise<SaveResult> {
  const { ctx } = await requireSession();
  try {
    const made = await createVehicle(ctx, { vin: text(form.get("vin")), specs: readSpecs(form), own: readOwn(form) });
    revalidatePath("/vehicles");
    return { ok: true, ...made };
  } catch (error) {
    if (!(error instanceof ValidationError || error instanceof StateError || error instanceof ForbiddenError)) console.error("vehicles: create failed", error);
    return { ok: false, error: plain(error) };
  }
}

export async function saveVehicle(id: string, form: FormData): Promise<void> {
  const { ctx } = await requireSession();
  try {
    await updateVehicle(ctx, id, { own: readOwn(form), specs: readSpecs(form), vin: text(form.get("vin")) });
  } catch (error) {
    redirect(`/vehicles/${id}?error=${encodeURIComponent(plain(error))}`);
  }
  revalidatePath(`/vehicles/${id}`);
  redirect(`/vehicles/${id}?notice=${encodeURIComponent("Saved.")}`);
}

export async function setVehicleStatus(id: string, status: string): Promise<void> {
  const { ctx } = await requireSession();
  if (!isVehicleStatus(status)) redirect(`/vehicles/${id}`);
  try {
    await updateVehicle(ctx, id, { own: { status } });
  } catch (error) {
    redirect(`/vehicles/${id}?error=${encodeURIComponent(plain(error))}`);
  }
  revalidatePath(`/vehicles/${id}`);
  revalidatePath("/vehicles");
  redirect(`/vehicles/${id}`);
}

export type ImportCheck = { ok: true; rows: VehicleImportRow[]; ready: number } | { ok: false; error: string };
export async function checkVehicleImport(text: string): Promise<ImportCheck> {
  const { ctx } = await requireSession();
  try {
    return { ok: true, ...(await planVehicleImport(ctx, text)) };
  } catch (error) {
    return { ok: false, error: plain(error) };
  }
}
export type ImportDone = { ok: true; added: { id: string; stockNumber: string; vin: string }[]; skipped: number } | { ok: false; error: string };
export async function doVehicleImport(text: string): Promise<ImportDone> {
  const { ctx } = await requireSession();
  try {
    const done = await runVehicleImport(ctx, text);
    revalidatePath("/vehicles");
    return { ok: true, ...done };
  } catch (error) {
    if (!(error instanceof ValidationError || error instanceof StateError || error instanceof ForbiddenError)) console.error("vehicles: import failed", error);
    return { ok: false, error: plain(error) };
  }
}

/** Money spent on a car after buying it. */
export async function addCost(vehicleId: string, form: FormData): Promise<void> {
  const { ctx } = await requireSession();
  try {
    await addVehicleCost(ctx, vehicleId, { kind: String(form.get("kind") ?? ""), description: String(form.get("description") ?? ""), amount: num(form.get("amount")) ?? 0, spentOn: String(form.get("spentOn") ?? "") });
  } catch (error) {
    redirect(`/vehicles/${vehicleId}?error=${encodeURIComponent(plain(error))}#costs`);
  }
  revalidatePath(`/vehicles/${vehicleId}`);
  redirect(`/vehicles/${vehicleId}?notice=${encodeURIComponent("Cost added.")}#costs`);
}

export async function deleteCost(vehicleId: string, costId: string): Promise<void> {
  const { ctx } = await requireSession();
  try {
    await removeVehicleCost(ctx, costId);
  } catch (error) {
    redirect(`/vehicles/${vehicleId}?error=${encodeURIComponent(plain(error))}#costs`);
  }
  revalidatePath(`/vehicles/${vehicleId}`);
  redirect(`/vehicles/${vehicleId}?notice=${encodeURIComponent("Cost removed.")}#costs`);
}

/** Makes a photo the cover: the first one listings and the window sticker show. */
export async function coverPhoto(vehicleId: string, fileId: string): Promise<void> {
  const { ctx } = await requireSession();
  try {
    await makeCoverPhoto(ctx, fileId);
  } catch (error) {
    redirect(`/vehicles/${vehicleId}?error=${encodeURIComponent(plain(error))}#photos`);
  }
  revalidatePath(`/vehicles/${vehicleId}`);
  redirect(`/vehicles/${vehicleId}#photos`);
}
