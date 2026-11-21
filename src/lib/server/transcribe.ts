/**
 * Transcripción de voz en el servidor (ElevenLabs Speech-to-Text). Solo servidor.
 *
 * Sin ELEVENLABS_API_KEY devuelve null y la transmisión queda con su grabación
 * y el texto UNTRANSCRIBED_COMM_TEXT: la app sigue funcionando sin credenciales.
 */
import { config } from "@/lib/config";
import { recordServerError } from "@/lib/server/diagnostics";

const STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const TIMEOUT_MS = 30_000;

export function isTranscriptionConfigured(): boolean {
  return Boolean(config.elevenLabsApiKey);
}

/** Texto de la grabación en español, o null si no hay servicio, falla o no se oyó nada. */
export async function transcribeAudio(bytes: Uint8Array, contentType: string, filename: string): Promise<string | null> {
  const key = config.elevenLabsApiKey;
  if (!key) return null;
  const form = new FormData();
  form.set("model_id", config.sttModel);
  form.set("language_code", "spa");
  form.set("tag_audio_events", "false");
  form.set("file", new Blob([bytes as BlobPart], { type: contentType }), filename);
  try {
    const res = await fetch(STT_URL, {
      method: "POST",
      headers: { "xi-api-key": key },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      console.error(`[vigia:stt] ElevenLabs respondió ${res.status}: ${detail}`);
      recordServerError("transcripcion", `ElevenLabs respondió ${res.status}: ${detail}`);
      return null;
    }
    const body = (await res.json()) as { text?: unknown };
    const text = typeof body.text === "string" ? body.text.trim().replace(/\s+/g, " ") : "";
    return text || null;
  } catch (err) {
    console.error(`[vigia:stt] no se pudo transcribir: ${err instanceof Error ? err.message : String(err)}`);
    recordServerError("transcripcion", err, { context: "No se pudo transcribir" });
    return null;
  }
}
