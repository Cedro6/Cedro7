import type { ModelCall } from "@bos/core";

/** The assistant is on only when an API key has been set for this deployment. */
export const assistantConfigured = (): boolean => Boolean(process.env.ANTHROPIC_API_KEY);

/** Questions each company may ask per month. Keeps the bill bounded. */
export const monthlyLimit = (): number => {
  const value = Number(process.env.ASSISTANT_MONTHLY_QUESTIONS ?? "300");
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 300;
};

const MODEL = () => process.env.ASSISTANT_MODEL || "claude-haiku-5-5";

// Ava's jobs are lookups and short write-ups, so the model is asked to think only briefly before answering.
// At its default setting it reasons at length first, which made answers slow and used up their length allowance.
const QUICK = { thinking: { type: "adaptive" }, output_config: { effort: "low" } };

export const callModel: ModelCall = async (request) => {
  const send = (extra: object) =>
    fetch(`${process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com"}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: MODEL(), ...request, ...(request.tools.length === 0 ? { tools: undefined } : {}), ...extra }),
      signal: AbortSignal.timeout(45_000),
    });
  let response = await send(QUICK);
  if (response.status === 400) {
    // A model that does not accept the quick setting still answers without it.
    console.warn("assistant: quick setting refused, retrying without it", (await response.text()).slice(0, 300));
    response = await send({});
  }
  if (!response.ok) {
    // The body can describe the account; keep it in the server log and out of the page.
    console.error("assistant: model request failed", response.status, (await response.text()).slice(0, 300));
    throw new Error(`Model request failed with status ${response.status}`);
  }
  const result = (await response.json()) as Awaited<ReturnType<ModelCall>>;
  // Running out of room cuts an answer off; note it so the allowance can be raised if it ever recurs.
  if (result.stop_reason === "max_tokens") console.warn("assistant: answer hit the length allowance", request.max_tokens, JSON.stringify(result.usage));
  return result;
};
