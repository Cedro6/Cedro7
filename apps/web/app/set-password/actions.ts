"use server";

import { redirect } from "next/navigation";
import { setPasswordWithLink, ValidationError } from "@bos/core";
import { pool } from "../../lib/pool";
import { startPending, startSession } from "../../lib/session";

export async function choosePassword(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");
  const back = `/set-password?token=${encodeURIComponent(token)}`;
  if (password !== String(formData.get("again") ?? "")) redirect(`${back}&error=${encodeURIComponent("The two passwords do not match.")}`);
  let session;
  try {
    session = await setPasswordWithLink(pool, token, password);
  } catch (error) {
    if (error instanceof ValidationError) redirect(`${back}&error=${encodeURIComponent(error.message)}`);
    throw error;
  }
  if (session.twoStep) {
    await startPending(session.userId, session.orgId, session.sessionVersion);
    redirect("/sign-in/verify");
  }
  await startSession(session.userId, session.orgId, session.sessionVersion);
  redirect("/");
}
