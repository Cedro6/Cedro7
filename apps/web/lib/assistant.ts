import type { ModelCall } from "@bos/core";

/** The assistant is on only when an API key has been set for this deployment. */
export const assistantConfigured = (): boolean => Boolean(process.env.ANTHROPIC_API_KEY);

/** Questions each company may ask per month. Keeps the bill bounded. */
export const monthlyLimit = (): number => {
  const value = Number(process.env.ASSISTANT_MONTHLY_QUESTIONS ?? "300");
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 300;
};

const MODEL = () => process.env.ASSISTANT_MODEL || "claude-haiku-5-5";

export const callModel: ModelCall = async (request) => {
  const response = await fetch(`${process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com"}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: MODEL(), ...request, ...(request.tools.length === 0 ? { tools: undefined } : {}) }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) {
    // The body can describe the account; keep it in the server log and out of the page.
    console.error("assistant: model request failed", response.status, (await response.text()).slice(0, 300));
    throw new Error(`Model request failed with status ${response.status}`);
  }
  return (await response.json()) as Awaited<ReturnType<ModelCall>>;
};
