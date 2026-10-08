"use server";

import { redirect } from "next/navigation";
import { adjustStock, ForbiddenError, InsufficientStockError, StockInputError } from "@bos/core";
import { requireSession } from "../../../../lib/session";

export async function saveAdjustment(formData: FormData): Promise<void> {
  const { ctx } = await requireSession();
  const productId = String(formData.get("productId") ?? "");
  const back = `/products/${encodeURIComponent(productId)}`;
  const amount = Number(String(formData.get("amount") ?? "").trim());
  const direction = formData.get("direction") === "remove" ? -1 : 1;
  let message = "";
  try {
    if (!(amount > 0)) throw new StockInputError("Enter a quantity greater than zero.");
    await adjustStock(ctx, {
      productId,
      qtyDelta: direction * amount,
      reason: String(formData.get("reason") ?? ""),
      idempotencyKey: String(formData.get("requestId") ?? ""),
    });
  } catch (error) {
    if (error instanceof InsufficientStockError) {
      message = `Only ${error.available} available to remove; the rest is reserved or not there.`;
    } else if (error instanceof StockInputError) {
      message = error.message;
    } else if (error instanceof ForbiddenError) {
      message = "Your role cannot adjust stock.";
    } else {
      throw error;
    }
  }
  redirect(message ? `${back}?error=${encodeURIComponent(message)}` : `${back}?saved=1`);
}
