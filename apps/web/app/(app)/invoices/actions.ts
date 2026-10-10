"use server";

import { redirect } from "next/navigation";
import {
  createInvoice,
  ForbiddenError,
  raiseCredit,
  recordPayment,
  requestDeposit,
  StateError,
  useCustomerCredit,
  ValidationError,
  voidInvoice,
} from "@bos/core";
import { formatMoney } from "../../../lib/format";
import { requireSession } from "../../../lib/session";

function friendly(error: unknown): string {
  if (error instanceof ValidationError || error instanceof StateError) return error.message;
  if (error instanceof ForbiddenError) return "Your role cannot do that.";
  throw error;
}

const number = (value: FormDataEntryValue | null): number => Number(String(value ?? "").trim() || "NaN");

async function act(formData: FormData, run: (invoiceId: string) => Promise<string>): Promise<void> {
  const invoiceId = String(formData.get("invoiceId") ?? "");
  let query: string;
  try {
    query = `notice=${encodeURIComponent(await run(invoiceId))}`;
  } catch (error) {
    query = `error=${encodeURIComponent(friendly(error))}`;
  }
  redirect(`/invoices/${encodeURIComponent(invoiceId)}?${query}`);
}

export async function pay(formData: FormData): Promise<void> {
  const { ctx } = await requireSession();
  await act(formData, async (invoiceId) => {
    const { balance } = await recordPayment(ctx, invoiceId, {
      amount: number(formData.get("amount")),
      method: String(formData.get("method") ?? ""),
      reference: String(formData.get("reference") ?? ""),
      idempotencyKey: String(formData.get("requestId") ?? ""),
    });
    return balance > 0 ? `Payment recorded. ${formatMoney(balance)} still owed.` : "Payment recorded. This invoice is paid.";
  });
}

export async function credit(formData: FormData): Promise<void> {
  const { ctx } = await requireSession();
  await act(formData, async (invoiceId) => {
    const result = await raiseCredit(ctx, {
      invoiceId,
      amount: number(formData.get("amount")),
      reason: String(formData.get("reason") ?? ""),
    });
    return result.onAccount > 0
      ? `${result.number} raised. ${formatMoney(result.applied)} came off this invoice and ${formatMoney(result.onAccount)} is on the customer's account.`
      : `${result.number} raised. ${formatMoney(result.applied)} came off this invoice.`;
  });
}

export async function useCredit(formData: FormData): Promise<void> {
  const { ctx } = await requireSession();
  await act(formData, async (invoiceId) => {
    const { applied, balance } = await useCustomerCredit(ctx, invoiceId);
    return balance > 0 ? `${formatMoney(applied)} of credit used. ${formatMoney(balance)} still owed.` : `${formatMoney(applied)} of credit used. This invoice is paid.`;
  });
}

export async function voidIt(formData: FormData): Promise<void> {
  const { ctx } = await requireSession();
  await act(formData, async (invoiceId) => {
    await voidInvoice(ctx, invoiceId, String(formData.get("reason") ?? ""));
    return "Invoice voided.";
  });
}

export async function deposit(formData: FormData): Promise<void> {
  const { ctx } = await requireSession();
  const orderId = String(formData.get("orderId") ?? "");
  let target: string;
  try {
    const made = await requestDeposit(ctx, orderId, number(formData.get("percent")));
    target = `/invoices/${made.id}?notice=${encodeURIComponent(`Deposit invoice ${made.number} raised for ${formatMoney(made.amount)}.`)}`;
  } catch (error) {
    target = `/sales/${encodeURIComponent(orderId)}?error=${encodeURIComponent(friendly(error))}`;
  }
  redirect(target);
}

export async function saveInvoice(formData: FormData): Promise<void> {
  const { ctx } = await requireSession();
  const descriptions = formData.getAll("description").map((value) => String(value).trim());
  const quantities = formData.getAll("qty").map((value) => String(value).trim());
  const prices = formData.getAll("unitPrice").map((value) => String(value).trim());
  const due = String(formData.get("dueInDays") ?? "").trim();
  let target: string;
  try {
    const made = await createInvoice(ctx, {
      customerId: String(formData.get("customerId") ?? ""),
      taxRatePercent: Number(String(formData.get("taxRatePercent") ?? "0").trim() || "0"),
      dueInDays: due === "" ? undefined : Number(due),
      notes: String(formData.get("notes") ?? ""),
      // a row left completely empty is ignored; a half-filled one is reported
      lines: descriptions.flatMap((description, index) =>
        description || quantities[index] || prices[index]
          ? [{ description, qty: Number(quantities[index] || "NaN"), unitPrice: Number(prices[index] || "NaN") }]
          : [],
      ),
    });
    target = `/invoices/${made.id}?notice=${encodeURIComponent(`Invoice ${made.number} saved.`)}`;
  } catch (error) {
    target = `/invoices/new?error=${encodeURIComponent(friendly(error))}`;
  }
  redirect(target);
}
