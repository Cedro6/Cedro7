/**
 * Ava's speaking voice, from ElevenLabs. It is on only when an API key has been set for this
 * deployment; without one Ava stays silent and nothing is sent or charged.
 */
export const voiceConfigured = (): boolean => Boolean(process.env.ELEVENLABS_API_KEY);

/** The longest reply Ava will read aloud. Keeps each spoken answer short and its cost small. */
export const MAX_SPOKEN = 400;

// Soft and natural: enough variation to sound like a person, steady enough to stay calm, a touch slower than normal speech.
const SETTINGS = { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 0.95 };
// "Sarah", ElevenLabs' soft-spoken American default voice. Set ELEVENLABS_VOICE_ID to use any other voice from their library.
const DEFAULT_VOICE = "EXAVITQu4vr4xnSDxMaL";
// Multilingual v2 sounds more natural than the faster Flash models, which the default voices are also tuned for.
const DEFAULT_MODEL = "eleven_multilingual_v2";

/** Why ElevenLabs would not speak, in words for the person, from its status code. */
function problem(status: number): string {
  if (status === 401) return "ElevenLabs did not accept the API key. Check ELEVENLABS_API_KEY in the site's settings.";
  if (status === 402 || status === 403) return "The ElevenLabs plan on this key does not allow this voice. Choose another voice or plan.";
  if (status === 404) return "ElevenLabs could not find the chosen voice. Check ELEVENLABS_VOICE_ID.";
  if (status === 429) return "The ElevenLabs account has run out of characters or is busy. Try again later.";
  return "ElevenLabs could not speak just now. Try again in a moment.";
}

/** Asks ElevenLabs to speak the text. Returns the audio stream, or the reason it could not. */
export async function speak(text: string): Promise<{ audio: ReadableStream<Uint8Array> } | { problem: string }> {
  const voice = /^[A-Za-z0-9]{10,40}$/.test(process.env.ELEVENLABS_VOICE_ID ?? "") ? process.env.ELEVENLABS_VOICE_ID! : DEFAULT_VOICE;
  const response = await fetch(`${process.env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io"}/v1/text-to-speech/${voice}/stream?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "content-type": "application/json", "xi-api-key": process.env.ELEVENLABS_API_KEY ?? "", accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: process.env.ELEVENLABS_MODEL || DEFAULT_MODEL, voice_settings: SETTINGS }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok || !response.body) {
    // The body can describe the account; keep it in the server log and out of the page.
    console.error("ava: voice request failed", response.status, (await response.text().catch(() => "")).slice(0, 300));
    return { problem: problem(response.status) };
  }
  return { audio: response.body };
}
