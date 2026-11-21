import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { buildOggOpus, opusPacketSamples } from "./protocol";
import { encodeOpus60ms, prepareForStt } from "./voice";

const hasFfmpeg = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout?.includes("libopus") ?? false;

test("encodeOpus60ms da paquetes Opus de 60 ms para 1 s de PCM 16 kHz", { skip: !hasFfmpeg && "sin ffmpeg con libopus" }, async () => {
  const samples = 16_000;
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i++) pcm[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 16_000));
  const packets = await encodeOpus60ms(new Uint8Array(pcm.buffer));
  assert.ok(packets.length >= 16 && packets.length <= 19, `paquetes: ${packets.length}`);
  for (const p of packets) assert.equal(opusPacketSamples(p), 2880); // 60 ms a 48 kHz
});

test("prepareForStt deja un WAV de 16 kHz con 0,6 s de margen a cada lado", { skip: !hasFfmpeg && "sin ffmpeg con libopus" }, async () => {
  const pcm = new Int16Array(16_000);
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(8000 * Math.sin((2 * Math.PI * 300 * i) / 16_000));
  const packets = await encodeOpus60ms(new Uint8Array(pcm.buffer));
  const wav = await prepareForStt(buildOggOpus(packets, { sampleRate: 16000, fallbackSamples: 2880 }));
  assert.equal(new TextDecoder().decode(wav.subarray(0, 4)), "RIFF");
  const seconds = (wav.byteLength - 44) / 2 / 16_000;
  assert.ok(seconds > 2.0 && seconds < 2.4, `duración ${seconds}`);
});
