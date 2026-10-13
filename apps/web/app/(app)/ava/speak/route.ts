import { MAX_SPOKEN, speak, voiceConfigured } from "../../../../lib/voice";
import { requireSession } from "../../../../lib/session";

/** Reads a short piece of Ava's reply aloud. Signed-in people only; the text is cut to a sentence or two. */
export async function POST(request: Request) {
  await requireSession();
  // There is no stand-in voice: when Ava cannot speak she says why instead of sounding like a machine.
  if (!voiceConfigured()) return Response.json({ problem: "Ava's voice is not set up yet. It needs an ElevenLabs API key in the site's settings." }, { status: 503 });
  const body = (await request.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.replace(/\s+/g, " ").trim().slice(0, MAX_SPOKEN) : "";
  if (!text) return Response.json({ problem: "Nothing to say." }, { status: 400 });
  const result = await speak(text).catch((error) => {
    console.error("ava: voice failed", error);
    return { problem: "ElevenLabs could not be reached. Try again in a moment." };
  });
  if ("problem" in result) return Response.json(result, { status: 502 });
  return new Response(result.audio, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
}
