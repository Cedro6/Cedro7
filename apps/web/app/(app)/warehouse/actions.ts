"use server";

import { redirect } from "next/navigation";
import { ForbiddenError, markPutAway, StockInputError, submitCount } from "@bos/core";
import { requireSession } from "../../../lib/session";

const text = (form: FormData, key: string) => String(form.get(key) ?? "");

export async function putAway(form: FormData): Promise<void> {
  const { ctx } = await requireSession();
  let message = "";
  try {
    await markPutAway(ctx, text(form, "lineId"), { shelf: text(form, "shelf") });
  } catch (error) {
    if (error instanceof StockInputError) message = error.message;
    else if (error instanceof ForbiddenError) message = "Your role cannot put stock away.";
    else throw error;
  }
  redirect(message ? `/warehouse?tab=putaway&error=${encodeURIComponent(message)}` : "/warehouse?tab=putaway&notice=Put%20away.");
}

export async function saveCount(form: FormData): Promise<void> {
  const { ctx } = await requireSession();
  const ids = form.getAll("productId").map(String);
  const counts = form.getAll("counted").map((value) => String(value).trim());
  // A blank box means "not counted", so that product is left alone.
  const lines = ids.flatMap((productId, index) => (counts[index] ? [{ productId, counted: Number(counts[index]) }] : []));
  const back = `/warehouse?tab=count${text(form, "category") ? `&category=${encodeURIComponent(text(form, "category"))}` : ""}${text(form, "shelf") ? `&shelf=${encodeURIComponent(text(form, "shelf"))}` : ""}`;
  let message = "";
  let notice = "";
  try {
    const result = await submitCount(ctx, { idempotencyKey: text(form, "requestId"), note: text(form, "note"), lines });
    notice =
      result.changed === 0
        ? `${result.counted} counted. Everything matched, so nothing changed.`
        : `${result.counted} counted. Stock corrected for ${result.changed} ${result.changed === 1 ? "product" : "products"}.`;
  } catch (error) {
    if (error instanceof StockInputError) message = error.message;
    else if (error instanceof ForbiddenError) message = "Your role cannot correct stock.";
    else throw error;
  }
  redirect(message ? `${back}&error=${encodeURIComponent(message)}` : `${back}&notice=${encodeURIComponent(notice)}`);
}
