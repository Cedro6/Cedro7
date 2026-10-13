/**
 * Ava's speaking voice, from ElevenLabs. It is on only when an API key has been set for this
 * deployment; without one the browser's own voice is used instead and nothing is sent or charged.
 */
export const voiceConfigured = (): boolean => Boolean(process.env.ELEVENLABS_API_KEY);

/** The longest reply Ava will read aloud. Keeps each spoken answer short and its cost small. */
export const MAX_SPOKEN = 400;

// A calm, unhurried delivery: steady rather than expressive, and a touch slower than normal speech.
const SETTINGS = { stability: 0.7, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 0.94 };
// "Rachel", one of ElevenLabs' standard calm voices. Set ELEVENLABS_VOICE_ID to use any other voice from their library.
const DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM";

/** Asks ElevenLabs to speak the text and returns the audio stream, or null if it could not. */
export async function speak(text: string): Promise<ReadableStream<Uint8Array> | null> {
  const voice = /^[A-Za-z0-9]{10,40}$/.test(process.env.ELEVENLABS_VOICE_ID ?? "") ? process.env.ELEVENLABS_VOICE_ID! : DEFAULT_VOICE;
  const response = await fetch(`${process.env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io"}/v1/text-to-speech/${voice}/stream?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "content-type": "application/json", "xi-api-key": process.env.ELEVENLABS_API_KEY ?? "", accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5", voice_settings: SETTINGS }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok || !response.body) {
    // The body can describe the account; keep it in the server log and out of the page.
    console.error("ava: voice request failed", response.status, (await response.text().catch(() => "")).slice(0, 300));
    return null;
  }
  return response.body;
}
