"use server";

import { ask, AssistantLimitError } from "@bos/core";
import { assistantConfigured, callModel, monthlyLimit } from "../../../lib/assistant";
import { requireSession } from "../../../lib/session";

export type AskState = { question: string; answer: string; error: string; lookups: number };

export async function askAssistant(_previous: AskState, form: FormData): Promise<AskState> {
  const { ctx, membership } = await requireSession();
  const question = String(form.get("question") ?? "").trim();
  const blank = { question, answer: "", lookups: 0 };
  if (!question) return { ...blank, error: "Type a question first." };
  if (!assistantConfigured()) return { ...blank, error: "The assistant has not been switched on for this site yet." };
  try {
    const result = await ask(ctx, { question, company: membership.orgName, person: membership.userName, monthlyLimit: monthlyLimit() }, callModel);
    return { question, answer: result.text, error: "", lookups: result.lookups.length };
  } catch (error) {
    if (error instanceof AssistantLimitError) {
      return { ...blank, error: `Your company has used all ${error.limit} assistant questions for this month. It resets on the 1st.` };
    }
    console.error("assistant: question failed", error);
    return { ...blank, error: "The assistant could not answer just now. Try again in a moment." };
  }
}
