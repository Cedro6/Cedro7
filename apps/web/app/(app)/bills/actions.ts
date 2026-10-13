"use server";

import { redirect } from "next/navigation";
import { createExpense, ForbiddenError, payExpense, StateError, ValidationError, voidExpense } from "@bos/core";
import { requireSession } from "../../../lib/session";

function friendly(error: unknown): string {
  if (error instanceof ValidationError || error instanceof StateError) return error.message;
  if (error instanceof ForbiddenError) return "Your role cannot do that.";
  throw error;
}
const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

export async function saveBill(form: FormData): Promise<void> {
  const { ctx } = await requireSession();
  const paid = form.get("paid") === "1";
  let target: string;
  try {
    const { id } = await createExpense(ctx, {
      description: text(form, "description"),
      category: text(form, "category"),
      amount: Number(text(form, "amount").replace(/[$,\s]/g, "") || "NaN"),
      incurredOn: text(form, "incurredOn"),
      dueOn: paid ? undefined : text(form, "dueOn"),
      supplierId: text(form, "supplierId"),
      reference: text(form, "reference"),
      paidOn: paid ? text(form, "paidOn") || text(form, "incurredOn") : undefined,
      paidMethod: paid ? text(form, "paidMethod") : undefined,
    });
    target = `/bills/${id}?notice=${encodeURIComponent("Saved.")}`;
  } catch (error) {
    target = `/bills/new?error=${encodeURIComponent(friendly(error))}`;
  }
  redirect(target);
}

async function act(form: FormData, done: string, run: (id: string) => Promise<void>): Promise<void> {
  const id = text(form, "id");
  let query: string;
  try {
    await run(id);
    query = `notice=${encodeURIComponent(done)}`;
  } catch (error) {
    query = `error=${encodeURIComponent(friendly(error))}`;
  }
  redirect(`/bills/${encodeURIComponent(id)}?${query}`);
}

export async function markPaid(form: FormData): Promise<void> {
  const { ctx } = await requireSession();
  await act(form, "Marked as paid.", (id) => payExpense(ctx, id, { paidOn: text(form, "paidOn"), method: text(form, "method") }));
}

export async function voidBill(form: FormData): Promise<void> {
  const { ctx } = await requireSession();
  await act(form, "Voided. It no longer counts anywhere.", (id) => voidExpense(ctx, id, text(form, "reason")));
}
