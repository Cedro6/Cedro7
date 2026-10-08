"use server";

import { redirect } from "next/navigation";
import { createCustomer, ForbiddenError, ValidationError } from "@bos/core";
import { requireSession } from "../../../../lib/session";

export async function saveCustomer(formData: FormData): Promise<void> {
  const { ctx } = await requireSession();
  let id: string;
  try {
    ({ id } = await createCustomer(ctx, {
      name: String(formData.get("name") ?? ""),
      paymentTerms: String(formData.get("paymentTerms") ?? ""),
    }));
  } catch (error) {
    if (error instanceof ValidationError) redirect(`/customers/new?error=${encodeURIComponent(error.message)}`);
    if (error instanceof ForbiddenError) redirect("/customers");
    throw error;
  }
  redirect(`/customers/${id}`);
}
