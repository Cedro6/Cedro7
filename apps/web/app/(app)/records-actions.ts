"use server";

import { redirect } from "next/navigation";
import {
  createProduct, ForbiddenError, removeContact, saveContact, setCustomerArchived, setProductArchived,
  setSupplierArchived, updateCustomer, updateProduct, updateSupplier, ValidationError, type ProductInput,
} from "@bos/core";
import { requireSession } from "../../lib/session";

const text = (form: FormData, key: string) => String(form.get(key) ?? "");
const optionalNumber = (form: FormData, key: string) => (text(form, key).trim() === "" ? undefined : Number(text(form, key)));

/** Runs a change and returns to `back` with a notice, or with the reason it was refused. */
async function run(back: string, notice: string, change: () => Promise<void>, onSuccess?: string): Promise<never> {
  let message = "";
  try {
    await change();
  } catch (error) {
    if (error instanceof ValidationError) message = error.message;
    else if (error instanceof ForbiddenError) message = "Your role cannot make that change.";
    else throw error;
  }
  const join = back.includes("?") ? "&" : "?";
  redirect(message ? `${back}${join}error=${encodeURIComponent(message)}` : `${onSuccess ?? back}${(onSuccess ?? back).includes("?") ? "&" : "?"}notice=${encodeURIComponent(notice)}`);
}

export async function editCustomer(form: FormData): Promise<void> {
  const { ctx } = await requireSession();
  const id = text(form, "id");
  await run(`/customers/${id}/edit`, "Customer saved.", () => updateCustomer(ctx, id, { name: text(form, "name"), paymentTerms: text(form, "paymentTerms"), billingAddress: text(form, "billingAddress"), shippingAddress: text(form, "shippingAddress"), taxExempt: form.get("taxExempt") === "1" }), `/customers/${id}`);
}

export async function archiveCustomer(form: FormData): Promise<void> {
  const { ctx } = await requireSession();
  const id = text(form, "id");
  const archived = text(form, "archived") === "1";
  await run(`/customers/${id}/edit`, archived ? "Customer archived." : "Customer restored.", () => setCustomerArchived(ctx, id, archived), archived ? "/customers" : `/customers/${id}`);
}

export async function editContact(form: FormData): Promise<void> {
  const { ctx } = await requireSession();
  const customerId = text(form, "customerId");
  const contactId = text(form, "contactId") || undefined;
  await run(`/customers/${customerId}/edit`, contactId ? "Contact saved." : "Contact added.", async () => {
    await saveContact(ctx, customerId, { name: text(form, "name"), title: text(form, "title"), email: text(form, "email"), phone: text(form, "phone"), isPrimary: form.get("isPrimary") === "on" }, contactId);
  });
}

export async function deleteContact(form: FormData): Promise<void> {
  const { ctx } = await requireSession();
  const customerId = text(form, "customerId");
  await run(`/customers/${customerId}/edit`, "Contact removed.", () => removeContact(ctx, customerId, text(form, "contactId")));
}

function productInput(form: FormData): ProductInput {
  const reorder = optionalNumber(form, "reorderPoint");
  return {
    sku: text(form, "sku"), name: text(form, "name"), category: text(form, "category"),
    price: Number(text(form, "price") || "0"), cost: optionalNumber(form, "cost"),
    shelfLocation: text(form, "shelfLocation"), reorderPoint: reorder === undefined ? null : reorder,
    barcode: text(form, "barcode"),
  };
}

export async function newProduct(form: FormData): Promise<void> {
  const { ctx } = await requireSession();
  let id = "";
  let message = "";
  try {
    ({ id } = await createProduct(ctx, productInput(form)));
  } catch (error) {
    if (error instanceof ValidationError) message = error.message;
    else if (error instanceof ForbiddenError) message = "Your role cannot add products.";
    else throw error;
  }
  redirect(message ? `/products/new?error=${encodeURIComponent(message)}` : `/products/${id}?notice=${encodeURIComponent("Product added.")}`);
}

export async function editProduct(form: FormData): Promise<void> {
  const { ctx } = await requireSession();
  const id = text(form, "id");
  await run(`/products/${id}/edit`, "Product saved.", () => updateProduct(ctx, id, productInput(form)), `/products/${id}`);
}

export async function archiveProduct(form: FormData): Promise<void> {
  const { ctx } = await requireSession();
  const id = text(form, "id");
  const archived = text(form, "archived") === "1";
  await run(`/products/${id}/edit`, archived ? "Product archived." : "Product restored.", () => setProductArchived(ctx, id, archived), archived ? "/products" : `/products/${id}`);
}

export async function editSupplier(form: FormData): Promise<void> {
  const { ctx } = await requireSession();
  const id = text(form, "id");
  await run(`/purchasing/suppliers/${id}`, "Supplier saved.", () =>
    updateSupplier(ctx, id, { name: text(form, "name"), email: text(form, "email"), phone: text(form, "phone"), paymentTerms: text(form, "paymentTerms"), leadTimeDays: optionalNumber(form, "leadTimeDays") }), "/purchasing");
}

export async function archiveSupplier(form: FormData): Promise<void> {
  const { ctx } = await requireSession();
  const id = text(form, "id");
  const archived = text(form, "archived") === "1";
  await run(`/purchasing/suppliers/${id}`, archived ? "Supplier archived." : "Supplier restored.", () => setSupplierArchived(ctx, id, archived), "/purchasing");
}
