"use server";

import { redirect } from "next/navigation";
import { endSession } from "../../lib/session";

export async function signOut(): Promise<void> {
  await endSession();
  redirect("/sign-in");
}
