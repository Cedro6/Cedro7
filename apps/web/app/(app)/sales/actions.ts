"use server";

import { redirect } from "next/navigation";
import {
  cancelOrder,
  createPriceList,
  deletePriceList,
  featureOn,
  setCustomerPriceList,
  confirmOrder,
  createQuote,
  ForbiddenError,
  InsufficientStockError,
  reserveAvailable,
  shipOrder,
  StateError,
  StockInputError,
  ValidationError,
} from "@bos/core";
import { requireSession } from "../../../lib/session";

function friendly(error: unknown): string {
  if (error instanceof ValidationError || error instanceof StateError || error instanceof StockInputError) {
    return error.message;
  }
  if (error instanceof InsufficientStockError) return "Stock changed while you were working. Please try again.";
  if (error instanceof ForbiddenError) return "Your role cannot do that.";
  throw error;
}

export async function saveQuote(formData: FormData): Promise<void> {
  const { ctx } = await requireSession();
  const productIds = formData.getAll("productId").map(String);
  const quantities = formData.getAll("qty").map((value) => Number(String(value).trim()));
  const discounts = formData.getAll("discountPercent").map((value) => Number(String(value).trim() || "0"));
  let id = "";
  let message = "";
  try {
    ({ id } = await createQuote(ctx, {
      customerId: String(formData.get("customerId") ?? ""),
      taxRatePercent: Number(String(formData.get("taxRatePercent") ?? "0").trim() || "0"),
      notes: String(formData.get("notes") ?? ""),
      lines: productIds.map((productId, index) => ({
        productId,
        qty: quantities[index] ?? Number.NaN,
        discountPercent: discounts[index] ?? 0,
      })),
    }));
  } catch (error) {
    message = friendly(error);
  }
  redirect(message ? `/sales/new?error=${encodeURIComponent(message)}` : `/sales/${id}`);
}

async function act(formData: FormData, run: (orderId: string) => Promise<string>): Promise<void> {
  const orderId = String(formData.get("orderId") ?? "");
  let query: string;
  try {
    query = `notice=${encodeURIComponent(await run(orderId))}`;
  } catch (error) {
    query = `error=${encodeURIComponent(friendly(error))}`;
  }
  redirect(`/sales/${encodeURIComponent(orderId)}?${query}`);
}

export async function confirm(formData: FormData): Promise<void> {
  const { ctx } = await requireSession();
  await act(formData, async (orderId) => {
    const { reserved } = await confirmOrder(ctx, orderId);
    return featureOn(ctx.features, "stock") ? `Order confirmed. ${reserved} units reserved.` : "Order confirmed.";
  });
}

export async function reserve(formData: FormData): Promise<void> {
  const { ctx } = await requireSession();
  await act(formData, async (orderId) => {
    const { reserved } = await reserveAvailable(ctx, orderId);
    return reserved > 0 ? `${reserved} more units reserved.` : "No more stock is available yet.";
  });
}

export async function ship(formData: FormData): Promise<void> {
  const { ctx } = await requireSession();
  await act(formData, async (orderId) => {
    const result = await shipOrder(ctx, orderId, { idempotencyKey: String(formData.get("requestId") ?? "") });
    const billed = result.invoice ? ` Invoice ${result.invoice.number} raised.` : "";
    return featureOn(ctx.features, "stock")
      ? `${result.shipmentNumber} shipped with ${result.units} units.${billed}`
      : `Order completed.${billed}`;
  });
}

export async function cancel(formData: FormData): Promise<void> {
  const { ctx } = await requireSession();
  await act(formData, async (orderId) => {
    const { released } = await cancelOrder(ctx, orderId);
    return released > 0 ? `Order cancelled. ${released} units returned to stock.` : "Order cancelled.";
  });
}

export async function savePriceList(formData: FormData): Promise<void> {
  const { ctx } = await requireSession();
  const products = formData.getAll("specialProductId").map(String);
  const prices = formData.getAll("specialPrice").map((value) => String(value).trim());
  let query: string;
  try {
    await createPriceList(ctx, {
      name: String(formData.get("name") ?? ""),
      percentOff: Number(String(formData.get("percentOff") ?? "0").trim() || "0"),
      specialPrices: products.flatMap((productId, index) =>
        productId && prices[index] ? [{ productId, price: Number(prices[index]) }] : [],
      ),
    });
    query = `notice=${encodeURIComponent("Price list saved.")}`;
  } catch (error) {
    query = `error=${encodeURIComponent(friendly(error))}`;
  }
  redirect(`/sales/price-lists?${query}`);
}

export async function removePriceList(formData: FormData): Promise<void> {
  const { ctx } = await requireSession();
  let query: string;
  try {
    const { customers } = await deletePriceList(ctx, String(formData.get("priceListId") ?? ""));
    query = `notice=${encodeURIComponent(
      customers > 0 ? `Price list deleted. ${customers} ${customers === 1 ? "customer is" : "customers are"} back on list prices.` : "Price list deleted.",
    )}`;
  } catch (error) {
    query = `error=${encodeURIComponent(friendly(error))}`;
  }
  redirect(`/sales/price-lists?${query}`);
}

export async function assignPriceList(formData: FormData): Promise<void> {
  const { ctx } = await requireSession();
  const customerId = String(formData.get("customerId") ?? "");
  let query: string;
  try {
    await setCustomerPriceList(ctx, customerId, String(formData.get("priceListId") ?? "") || null);
    query = `notice=${encodeURIComponent("Price list saved.")}`;
  } catch (error) {
    query = `error=${encodeURIComponent(friendly(error))}`;
  }
  redirect(`/customers/${encodeURIComponent(customerId)}?${query}`);
}
