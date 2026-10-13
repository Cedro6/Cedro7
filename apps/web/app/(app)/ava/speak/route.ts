import { MAX_SPOKEN, speak, voiceConfigured } from "../../../../lib/voice";
import { requireSession } from "../../../../lib/session";

/** Reads a short piece of Ava's reply aloud. Signed-in people only; the text is cut to a sentence or two. */
export async function POST(request: Request) {
  await requireSession();
  // 204 tells the page to fall back to the browser's own voice.
  if (!voiceConfigured()) return new Response(null, { status: 204 });
  const body = (await request.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.replace(/\s+/g, " ").trim().slice(0, MAX_SPOKEN) : "";
  if (!text) return new Response("Nothing to say", { status: 400 });
  const audio = await speak(text).catch((error) => {
    console.error("ava: voice failed", error);
    return null;
  });
  if (!audio) return new Response(null, { status: 204 });
  return new Response(audio, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
}
