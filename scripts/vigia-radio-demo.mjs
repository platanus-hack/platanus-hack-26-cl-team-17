#!/usr/bin/env node
/**
 * Genera los dos audios de radio de PRUEBA para el modo demo de Vigía (public/demo/).
 * Dos voces distintas de ElevenLabs en español + filtro de radio con ffmpeg (banda
 * 300–3400 Hz, compresión, ruido y "clic" de transmisión). Los audios reales de Agustín
 * reemplazan estos archivos con el mismo nombre.
 *
 * Uso (desde vigia/):
 *   node --env-file=.env.local scripts/vigia-radio-demo.mjs
 * Necesita ELEVENLABS_API_KEY y ffmpeg en el PATH. No imprime la llave.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const KEY = (process.env.ELEVENLABS_API_KEY ?? "").trim();
if (!KEY) {
  console.error("Falta ELEVENLABS_API_KEY (usa --env-file=.env.local).");
  process.exit(1);
}
const MODEL = process.env.VIGIA_DEMO_TTS_MODEL || "eleven_multilingual_v2";
const OUT = path.resolve("public/demo");

// El guion vive en src/lib/vigia/demo-script.ts; aquí se repite solo el texto de cada radio
// para no depender de TypeScript en este script.
const RADIOS = [
  {
    file: "radio-b3.mp3",
    text:
      "Central, B-3, seis cero, OBAC cuarenta y tres con ocho voluntarios. Siete cero en la esquina norte. Es un diez seis, fuerte olor a gas en la calle. ... " +
      "B-3 a Central, se solicita uno dos por un vecino con mareos. Cortamos el tránsito en la cuadra.",
  },
  {
    file: "radio-b5.mp3",
    text:
      "Central, B-5, seis tres por el lado C. Armados a grifo en la esquina sur. ... " +
      "B-5 informa: tercer piso despejado por el lado C, sin moradores a la vista.",
  },
];

async function voices() {
  const res = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": KEY } });
  if (!res.ok) throw new Error(`No pude listar las voces de ElevenLabs (HTTP ${res.status}).`);
  const body = await res.json();
  const all = body.voices ?? [];
  const male = all.filter((v) => (v.labels?.gender ?? "").toLowerCase() === "male");
  const pick = (male.length >= 2 ? male : all).slice(0, 2);
  if (pick.length < 2) throw new Error("La cuenta de ElevenLabs no tiene dos voces disponibles.");
  return pick.map((v) => ({ id: v.voice_id, name: v.name }));
}

async function tts(voiceId, text) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": KEY, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({
      text,
      model_id: MODEL,
      language_code: "es",
      voice_settings: { stability: 0.45, similarity_boost: 0.7, style: 0.2, speed: 1.08 },
    }),
  });
  if (!res.ok) throw new Error(`ElevenLabs respondió HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

function radioFilter(input, output) {
  // Banda de radio, compresión fuerte, algo de ruido de fondo y un clic de PTT al inicio y al final.
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.02:duration=60",
    "-i", input,
    "-filter_complex",
    "[1:a]aresample=16000,highpass=f=300,lowpass=f=3400,acompressor=threshold=-20dB:ratio=6:attack=5:release=60,volume=2.2,apad=pad_dur=0.25[v];" +
      "[0:a]aresample=16000,highpass=f=400,lowpass=f=3000[n];" +
      "[v][n]amix=inputs=2:duration=first:weights=1 0.6,afade=t=in:d=0.05,aresample=44100[out]",
    "-map", "[out]", "-ac", "1", "-b:a", "96k", output,
  ]);
}

const picked = await voices();
fs.mkdirSync(OUT, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vigia-radio-"));
for (const [i, r] of RADIOS.entries()) {
  const v = picked[i];
  const raw = path.join(tmp, `raw-${i}.mp3`);
  fs.writeFileSync(raw, await tts(v.id, r.text));
  radioFilter(raw, path.join(OUT, r.file));
  console.log(`${r.file}: voz "${v.name}" → public/demo/${r.file}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log("Listo. Son audios de PRUEBA: reemplázalos por los reales con el mismo nombre.");
