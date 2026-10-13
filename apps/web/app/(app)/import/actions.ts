"use server";

import { revalidatePath } from "next/cache";
import { ForbiddenError, InsufficientStockError, isImportKind, planImport, runImport, StockInputError, ValidationError, type ImportPlan } from "@bos/core";
import { requireSession } from "../../../lib/session";

export type ImportResult = { ok: true; plan: ImportPlan } | { ok: false; error: string };

function failure(error: unknown): ImportResult {
  if (error instanceof ValidationError || error instanceof StockInputError || error instanceof InsufficientStockError) return { ok: false, error: error.message };
  if (error instanceof ForbiddenError) return { ok: false, error: "Your role cannot import these." };
  throw error;
}

/** Reads the file and reports what importing it would do. Changes nothing. */
export async function checkImport(kind: string, text: string): Promise<ImportResult> {
  const { ctx } = await requireSession();
  if (!isImportKind(kind)) return { ok: false, error: "Choose what to import." };
  try {
    return { ok: true, plan: await planImport(ctx, kind, text) };
  } catch (error) {
    return failure(error);
  }
}

export async function doImport(kind: string, text: string, key: string): Promise<ImportResult> {
  const { ctx } = await requireSession();
  if (!isImportKind(kind)) return { ok: false, error: "Choose what to import." };
  try {
    const plan = await runImport(ctx, kind, text, key);
    revalidatePath("/", "layout");
    return { ok: true, plan };
  } catch (error) {
    return failure(error);
  }
}
