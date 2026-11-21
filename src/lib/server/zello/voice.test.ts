import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { opusPacketSamples } from "./protocol";
import { encodeOpus60ms } from "./voice";

const hasFfmpeg = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout?.includes("libopus") ?? false;

test("encodeOpus60ms da paquetes Opus de 60 ms para 1 s de PCM 16 kHz", { skip: !hasFfmpeg && "sin ffmpeg con libopus" }, async () => {
  const samples = 16_000;
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i++) pcm[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 16_000));
  const packets = await encodeOpus60ms(new Uint8Array(pcm.buffer));
  assert.ok(packets.length >= 16 && packets.length <= 19, `paquetes: ${packets.length}`);
  for (const p of packets) assert.equal(opusPacketSamples(p), 2880); // 60 ms a 48 kHz
});
