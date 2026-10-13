"use server";

import { redirect } from "next/navigation";
import { openSignupLink, signUp, ValidationError } from "@bos/core";
import { pool } from "../../lib/pool";
import { startSession } from "../../lib/session";

/** `values` is what was typed (never the password), so a refused form comes back filled in. */
export type SignUpState = { error: string; field: string; values: Record<string, string> };

/** Creates the company and signs its owner in. On a mistake the form keeps what was typed and says what to fix. */
export async function createCompany(_previous: SignUpState, form: FormData): Promise<SignUpState> {
  const text = (key: string) => String(form.get(key) ?? "");
  const values = Object.fromEntries(["company", "businessType", "timeZone", "currency", "taxPercent", "name", "email"].map((k) => [k, text(k)]));
  if (text("password") !== text("again")) return { error: "The two passwords do not match.", field: "again", values };
  const tax = text("taxPercent").trim();
  let session;
  try {
    session = await signUp(pool, text("token") || (await openSignupLink(pool)), {
      company: text("company"), businessType: text("businessType"), timeZone: text("timeZone"), currency: text("currency"),
      taxPercent: tax === "" ? 0 : Number(tax), name: text("name"), email: text("email"), password: text("password"),
    });
  } catch (error) {
    if (error instanceof ValidationError) return { error: error.message, field: error.field, values };
    throw error;
  }
  await startSession(session.userId, session.orgId, session.sessionVersion);
  redirect("/welcome");
}
