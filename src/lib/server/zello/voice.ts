/**
 * Voz de Vigía para Zello: texto → ElevenLabs TTS (PCM 16 kHz mono) → Opus en
 * cuadros de 60 ms (ffmpeg con libopus) → paquetes listos para sendVoice.
 * Lo usa el puente tools/zello-bridge.
 */
import { spawn } from "node:child_process";
import { buildCodecHeader, oggOpusAudioPackets, type ZelloCodecHeader } from "./protocol";

/** Lo que Vigía transmite: 16 kHz, un cuadro de 60 ms por paquete (codec_header "gD4BPA=="). */
export const VIGIA_TX_CODEC: ZelloCodecHeader = { sampleRate: 16_000, framesPerPacket: 1, frameSizeMs: 60 };

/**
 * Voz de prueba mientras no esté ELEVENLABS_VOICE_ID: «George», una de las voces
 * de la biblioteca base de ElevenLabs (con el modelo multilingüe habla español).
 */
export const TEST_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";

const TTS_TIMEOUT_MS = 20_000;
const MAX_TTS_CHARS = 600;

export interface VoicePackets {
  packets: Uint8Array[];
  codecHeader: string;
  packetDurationMs: number;
}

/** PCM 16 bits little-endian, mono, 16 kHz. */
export async function synthesizePcm16k(text: string, opts: { apiKey: string; voiceId?: string; modelId: string }): Promise<Uint8Array> {
  const voice = opts.voiceId || TEST_VOICE_ID;
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=pcm_16000`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "xi-api-key": opts.apiKey, "content-type": "application/json", accept: "audio/pcm" },
    body: JSON.stringify({ text: text.slice(0, MAX_TTS_CHARS), model_id: opts.modelId, language_code: "es" }),
    signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`ElevenLabs TTS respondió ${res.status}: ${detail}`);
  }
  const pcm = new Uint8Array(await res.arrayBuffer());
  if (pcm.byteLength < 320) throw new Error("ElevenLabs devolvió un audio vacío.");
  return pcm;
}

/** Codifica PCM 16 kHz mono en paquetes Opus de 60 ms (ffmpeg + libopus). */
export function encodeOpus60ms(pcm: Uint8Array, opts: { ffmpeg?: string; bitrate?: string } = {}): Promise<Uint8Array[]> {
  const args = [
    "-hide_banner", "-loglevel", "error",
    "-f", "s16le", "-ar", "16000", "-ac", "1", "-i", "pipe:0",
    "-c:a", "libopus", "-application", "voip", "-frame_duration", "60", "-b:a", opts.bitrate ?? "24k",
    "-f", "ogg", "pipe:1",
  ];
  return new Promise((resolve, reject) => {
    const proc = spawn(opts.ffmpeg ?? "ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    proc.stdout.on("data", (d: Buffer) => out.push(d));
    proc.stderr.on("data", (d: Buffer) => (err += d.toString()));
    proc.on("error", (e) => reject(new Error(`no se pudo ejecutar ffmpeg: ${e.message}`)));
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg terminó con código ${code}: ${err.slice(0, 300)}`));
      try {
        resolve(oggOpusAudioPackets(new Uint8Array(Buffer.concat(out))));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    proc.stdin.on("error", () => undefined); // si ffmpeg muere antes, el error sale por close
    proc.stdin.end(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  });
}

/** Texto → paquetes para Zello. */
export async function speakToPackets(
  text: string,
  opts: { apiKey: string; voiceId?: string; modelId: string; ffmpeg?: string },
): Promise<VoicePackets> {
  const pcm = await synthesizePcm16k(text, opts);
  const packets = await encodeOpus60ms(pcm, { ffmpeg: opts.ffmpeg });
  return { packets, codecHeader: buildCodecHeader(VIGIA_TX_CODEC), packetDurationMs: VIGIA_TX_CODEC.frameSizeMs };
}

/** WAV PCM 16 bits mono a partir de muestras crudas. */
export function wavFromPcm16(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + pcm.byteLength);
  const v = new DataView(out.buffer);
  const tag = (o: number, t: string) => [...t].forEach((c, i) => (out[o + i] = c.charCodeAt(0)));
  tag(0, "RIFF");
  v.setUint32(4, 36 + pcm.byteLength, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, "data");
  v.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
}

/**
 * Prepara una transmisión para la transcripción: los teléfonos llegan muy saturados y
 * las transmisiones cortas sin margen; con 0,6 s de silencio a cada lado, menos volumen
 * y sin graves, ElevenLabs transcribe más de las cortas (medido con grabaciones reales).
 * Devuelve un WAV de 16 kHz.
 */
export function prepareForStt(ogg: Uint8Array, opts: { ffmpeg?: string } = {}): Promise<Uint8Array> {
  const args = [
    "-hide_banner", "-loglevel", "error",
    "-f", "ogg", "-i", "pipe:0",
    "-af", "highpass=f=120,volume=-9dB,adelay=600:all=1,apad=pad_dur=0.6",
    "-ar", "16000", "-ac", "1", "-f", "s16le", "pipe:1",
  ];
  return new Promise((resolve, reject) => {
    const proc = spawn(opts.ffmpeg ?? "ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    proc.stdout.on("data", (d: Buffer) => out.push(d));
    proc.stderr.on("data", (d: Buffer) => (err += d.toString()));
    proc.on("error", (e) => reject(new Error(`no se pudo ejecutar ffmpeg: ${e.message}`)));
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg terminó con código ${code}: ${err.slice(0, 300)}`));
      resolve(wavFromPcm16(new Uint8Array(Buffer.concat(out)), 16_000));
    });
    proc.stdin.on("error", () => undefined);
    proc.stdin.end(Buffer.from(ogg.buffer, ogg.byteOffset, ogg.byteLength));
  });
}
