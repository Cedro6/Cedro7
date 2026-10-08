"use server";

import { redirect } from "next/navigation";
import {
  approvePurchaseOrder,
  cancelPurchaseOrder,
  createPurchaseOrder,
  createSupplier,
  ForbiddenError,
  InsufficientStockError,
  markPurchaseOrderSent,
  receivePurchaseOrder,
  StateError,
  StockInputError,
  submitPurchaseOrder,
  ValidationError,
} from "@bos/core";
import { formatQty } from "../../../lib/format";
import { requireSession } from "../../../lib/session";

function friendly(error: unknown): string {
  if (error instanceof ValidationError || error instanceof StateError || error instanceof StockInputError) {
    return error.message;
  }
  if (error instanceof InsufficientStockError) return "Stock changed while you were working. Please try again.";
  if (error instanceof ForbiddenError) return "Your role cannot do that.";
  throw error;
}

const number = (value: FormDataEntryValue | null): number => Number(String(value ?? "").trim());

export async function savePurchaseOrder(formData: FormData): Promise<void> {
  const { ctx } = await requireSession();
  const productIds = formData.getAll("productId").map(String);
  const quantities = formData.getAll("qty").map(number);
  const costs = formData.getAll("unitCost").map(number);
  let id = "";
  let message = "";
  try {
    ({ id } = await createPurchaseOrder(ctx, {
      supplierId: String(formData.get("supplierId") ?? ""),
      expectedOn: String(formData.get("expectedOn") ?? ""),
      notes: String(formData.get("notes") ?? ""),
      lines: productIds.map((productId, index) => ({
        productId,
        qty: quantities[index] ?? Number.NaN,
        unitCost: costs[index] ?? Number.NaN,
      })),
    }));
  } catch (error) {
    message = friendly(error);
  }
  redirect(message ? `/purchasing/new?error=${encodeURIComponent(message)}` : `/purchasing/${id}`);
}

export async function saveSupplier(formData: FormData): Promise<void> {
  const { ctx } = await requireSession();
  const lead = String(formData.get("leadTimeDays") ?? "").trim();
  let message = "";
  try {
    await createSupplier(ctx, {
      name: String(formData.get("name") ?? ""),
      email: String(formData.get("email") ?? ""),
      phone: String(formData.get("phone") ?? ""),
      paymentTerms: String(formData.get("paymentTerms") ?? ""),
      leadTimeDays: lead ? Number(lead) : undefined,
    });
  } catch (error) {
    message = friendly(error);
  }
  redirect(message ? `/purchasing/suppliers/new?error=${encodeURIComponent(message)}` : "/purchasing");
}

async function act(formData: FormData, run: (orderId: string) => Promise<string>): Promise<void> {
  const orderId = String(formData.get("orderId") ?? "");
  let query: string;
  try {
    query = `notice=${encodeURIComponent(await run(orderId))}`;
  } catch (error) {
    query = `error=${encodeURIComponent(friendly(error))}`;
  }
  redirect(`/purchasing/${encodeURIComponent(orderId)}?${query}`);
}

export async function submit(formData: FormData): Promise<void> {
  const { ctx } = await requireSession();
  await act(formData, async (orderId) => {
    const { status } = await submitPurchaseOrder(ctx, orderId);
    return status === "approved" ? "Purchase order approved." : "Submitted. It now needs approval from an owner or admin.";
  });
}

export async function approve(formData: FormData): Promise<void> {
  const { ctx } = await requireSession();
  await act(formData, async (orderId) => {
    await approvePurchaseOrder(ctx, orderId);
    return "Purchase order approved.";
  });
}

export async function markSent(formData: FormData): Promise<void> {
  const { ctx } = await requireSession();
  await act(formData, async (orderId) => {
    await markPurchaseOrderSent(ctx, orderId);
    return "Marked as sent to the supplier.";
  });
}

export async function cancel(formData: FormData): Promise<void> {
  const { ctx } = await requireSession();
  await act(formData, async (orderId) => {
    await cancelPurchaseOrder(ctx, orderId);
    return "Purchase order cancelled.";
  });
}

export async function receive(formData: FormData): Promise<void> {
  const { ctx } = await requireSession();
  await act(formData, async (orderId) => {
    const lineIds = formData.getAll("lineId").map(String);
    const quantities = formData.getAll("receiveQty").map((value) => number(value) || 0);
    const result = await receivePurchaseOrder(ctx, orderId, {
      idempotencyKey: String(formData.get("requestId") ?? ""),
      lines: lineIds.map((lineId, index) => ({ lineId, qty: quantities[index] ?? 0 })),
    });
    const filled =
      result.allocatedToBackorders > 0
        ? ` ${formatQty(result.allocatedToBackorders)} went straight to waiting customer orders.`
        : "";
    return `${result.receiptNumber}: ${formatQty(result.units)} units received.${filled}`;
  });
}
