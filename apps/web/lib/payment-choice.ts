import { PAYMENT_METHODS, type InvoicePayment } from "@bos/core";

/**
 * Turns the Payment selector into what the core expects: money taken now, or a number of days until
 * it is due. Anything unrecognised falls back to paid in full, which is what the form offers first.
 */
export function readPaymentChoice(form: FormData): { payment?: InvoicePayment; dueInDays?: number } {
  const choice = String(form.get("paymentChoice") ?? "paid");
  if (choice === "paid") {
    const method = String(form.get("paymentMethod") ?? "Cash");
    return {
      payment: {
        method: (PAYMENT_METHODS as readonly string[]).includes(method) ? method : "Cash",
        reference: String(form.get("paymentReference") ?? "").trim() || undefined,
      },
      dueInDays: 0,
    };
  }
  if (choice === "receipt") return { dueInDays: 0 };
  if (choice === "custom") {
    const days = Number(String(form.get("dueInDays") ?? "").trim());
    return { dueInDays: Number.isFinite(days) ? days : 30 };
  }
  const days = Number(choice);
  return { dueInDays: Number.isFinite(days) ? days : 0 };
}
