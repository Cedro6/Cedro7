"use server";

import { revalidatePath } from "next/cache";
import { ask, AssistantLimitError, writeBriefing, confirmProposal, dismissProposal, ForbiddenError, StateError, ValidationError, type AssistantTurn } from "@bos/core";
import { assistantConfigured, callModel, monthlyLimit } from "../../../lib/assistant";
import { requireSession } from "../../../lib/session";

export type AskResult = { answer: string; error: string; lookups: number; proposals: { id: string; summary: string }[] };

export async function askAssistant(question: string, history: AssistantTurn[]): Promise<AskResult> {
  const { ctx, membership } = await requireSession();
  const blank = { answer: "", lookups: 0, proposals: [] };
  const asked = String(question ?? "").trim();
  if (!asked) return { ...blank, error: "Type a question first." };
  if (!assistantConfigured()) return { ...blank, error: "The assistant has not been switched on for this site yet." };
  const turns = (Array.isArray(history) ? history : [])
    .filter((turn) => (turn?.role === "user" || turn?.role === "assistant") && typeof turn.text === "string")
    .slice(-8);
  try {
    const result = await ask(ctx, { question: asked, company: membership.orgName, person: membership.userName, monthlyLimit: monthlyLimit(), history: turns }, callModel);
    return { answer: result.text, error: "", lookups: result.lookups.length, proposals: result.proposals.map(({ id, summary }) => ({ id, summary })) };
  } catch (error) {
    if (error instanceof AssistantLimitError) {
      return { ...blank, error: `Your company has used all ${error.limit} assistant questions for this month. It resets on the 1st.` };
    }
    console.error("assistant: question failed", error);
    return { ...blank, error: "The assistant could not answer just now. Try again in a moment." };
  }
}

export type ConfirmResult = { ok: boolean; message: string; link: string };

/** Carries out a change the assistant prepared. Runs with the signed-in person's own permissions. */
export async function confirmChange(proposalId: string): Promise<ConfirmResult> {
  const { ctx } = await requireSession();
  try {
    const done = await confirmProposal(ctx, String(proposalId));
    revalidatePath("/", "layout");
    return { ok: true, ...done };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, message: "Your role cannot make that change.", link: "" };
    if (error instanceof ValidationError || error instanceof StateError) return { ok: false, message: error.message, link: "" };
    console.error("assistant: confirm failed", error);
    return { ok: false, message: "That could not be done just now. Nothing was changed.", link: "" };
  }
}

export async function dismissChange(proposalId: string): Promise<void> {
  const { ctx } = await requireSession();
  await dismissProposal(ctx, String(proposalId));
}

export type BriefingResult = { body: string; error: string };

/** Writes today's briefing for the signed-in person. One question against the monthly limit. */
export async function writeMyBriefing(): Promise<BriefingResult> {
  const { ctx, membership } = await requireSession();
  if (!assistantConfigured()) return { body: "", error: "The assistant has not been switched on for this site yet." };
  try {
    const briefing = await writeBriefing(ctx, { company: membership.orgName, person: membership.userName, monthlyLimit: monthlyLimit() }, callModel);
    revalidatePath("/");
    return { body: briefing.body, error: "" };
  } catch (error) {
    if (error instanceof AssistantLimitError) return { body: "", error: `Your company has used all ${error.limit} assistant questions for this month.` };
    console.error("assistant: briefing failed", error);
    return { body: "", error: "The briefing could not be written just now. Try again in a moment." };
  }
}
