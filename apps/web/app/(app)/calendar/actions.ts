"use server";

import { redirect } from "next/navigation";
import { createReminder, ForbiddenError, removeReminder, setReminderDone, ValidationError } from "@bos/core";
import { requireSession } from "../../../lib/session";

const text = (form: FormData, key: string) => String(form.get(key) ?? "");
/** Only paths inside this app are followed back. */
const safeBack = (form: FormData) => {
  const back = text(form, "back");
  return back.startsWith("/") && !back.startsWith("//") ? back : "/calendar";
};

async function run(form: FormData, notice: string, change: () => Promise<unknown>): Promise<never> {
  const back = safeBack(form);
  let message = "";
  try {
    await change();
  } catch (error) {
    if (error instanceof ValidationError) message = error.message;
    else if (error instanceof ForbiddenError) message = "The calendar is switched off for this company.";
    else throw error;
  }
  const join = back.includes("?") ? "&" : "?";
  redirect(`${back}${join}${message ? `error=${encodeURIComponent(message)}` : `notice=${encodeURIComponent(notice)}`}`);
}

export async function addReminder(form: FormData): Promise<void> {
  const { ctx } = await requireSession();
  await run(form, "Reminder added.", () =>
    createReminder(ctx, { title: text(form, "title"), dueOn: text(form, "dueOn"), customerId: text(form, "customerId") || undefined, assignedTo: text(form, "assignedTo") || undefined }),
  );
}

export async function toggleReminder(form: FormData): Promise<void> {
  const { ctx } = await requireSession();
  const done = text(form, "done") === "1";
  await run(form, done ? "Marked as done." : "Reopened.", () => setReminderDone(ctx, text(form, "id"), done));
}

export async function deleteReminder(form: FormData): Promise<void> {
  const { ctx } = await requireSession();
  await run(form, "Reminder removed.", () => removeReminder(ctx, text(form, "id")));
}
