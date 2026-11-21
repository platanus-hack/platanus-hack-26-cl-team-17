import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCodecHeader,
  buildOggOpus,
  encodeZelloAudioPacket,
  oggCrc,
  oggOpusAudioPackets,
  opusDurationSeconds,
  opusPacketSamples,
  parseCodecHeader,
  parseOggPackets,
  parseZelloPacket,
} from "./protocol";

test("parseZelloPacket lee tipo, stream_id y packet_id en big endian", () => {
  const buf = new Uint8Array([1, 0, 0, 0x11, 0xd7, 0, 0, 0, 5, 0xaa, 0xbb]);
  const p = parseZelloPacket(buf);
  assert.ok(p);
  assert.equal(p.streamId, 4567);
  assert.equal(p.packetId, 5);
  assert.deepEqual([...p.data], [0xaa, 0xbb]);
  assert.equal(parseZelloPacket(new Uint8Array([2, 0, 0, 0, 1, 0, 0, 0, 1, 9])), null);
  assert.equal(parseZelloPacket(new Uint8Array([1, 0, 0])), null);
});

test("parseCodecHeader decodifica el codec_header de Zello", () => {
  // 16000 Hz LE = 0x80 0x3E, 1 cuadro por paquete, 60 ms.
  const b64 = Buffer.from([0x80, 0x3e, 1, 60]).toString("base64");
  assert.deepEqual(parseCodecHeader(b64), { sampleRate: 16000, framesPerPacket: 1, frameSizeMs: 60 });
  assert.equal(parseCodecHeader(undefined).frameSizeMs, 60);
});

test("opusPacketSamples sigue el TOC de RFC 6716", () => {
  // config 3 (SILK 60 ms), code 0 → 2880 muestras.
  assert.equal(opusPacketSamples(new Uint8Array([(3 << 3) | 0])), 2880);
  // config 19 (CELT 20 ms), code 1 → 2 cuadros.
  assert.equal(opusPacketSamples(new Uint8Array([(19 << 3) | 1])), 1920);
  // code 3 con 3 cuadros de 20 ms (config 9, SILK).
  assert.equal(opusPacketSamples(new Uint8Array([(9 << 3) | 3, 3])), 2880);
  assert.equal(opusPacketSamples(new Uint8Array([])), 0);
});

test("oggCrc coincide con el CRC de Ogg conocido", () => {
  // CRC-32/MPEG-2 sin xor final y con inicio 0 ("CRC-32/OGG"): "123456789" → 0x89a1897f.
  assert.equal(oggCrc(new TextEncoder().encode("123456789")), 0x89a1897f);
});

test("buildOggOpus arma páginas válidas con granule acumulado", () => {
  const pkt = new Uint8Array(300).fill(0);
  pkt[0] = 3 << 3; // 60 ms
  const ogg = buildOggOpus([pkt, pkt], { sampleRate: 16000, fallbackSamples: 2880 });
  const view = new DataView(ogg.buffer);
  // Recorre las páginas y verifica cada CRC.
  let off = 0;
  const granules: bigint[] = [];
  const flags: number[] = [];
  while (off < ogg.byteLength) {
    assert.equal(new TextDecoder().decode(ogg.subarray(off, off + 4)), "OggS");
    const nseg = ogg[off + 26];
    let body = 0;
    for (let i = 0; i < nseg; i++) body += ogg[off + 27 + i];
    const len = 27 + nseg + body;
    const page = ogg.slice(off, off + len);
    const crc = new DataView(page.buffer).getUint32(22, true);
    page.fill(0, 22, 26);
    assert.equal(oggCrc(page), crc);
    granules.push(view.getBigInt64(off + 6, true));
    flags.push(ogg[off + 5]);
    off += len;
  }
  assert.deepEqual(granules, [BigInt(0), BigInt(0), BigInt(2880), BigInt(5760)]);
  assert.deepEqual(flags, [0x02, 0, 0, 0x04]);
  assert.equal(opusDurationSeconds([pkt, pkt], 2880), 0.12);
});

test("encodeZelloAudioPacket es el inverso de parseZelloPacket (packet_id en cero)", () => {
  const out = encodeZelloAudioPacket(0x01020304, new Uint8Array([7, 8, 9]));
  assert.deepEqual([...out.subarray(0, 9)], [1, 1, 2, 3, 4, 0, 0, 0, 0]);
  const back = parseZelloPacket(out);
  assert.ok(back);
  assert.equal(back.streamId, 0x01020304);
  assert.deepEqual([...back.data], [7, 8, 9]);
});

test("buildCodecHeader produce el ejemplo de la documentación (16 kHz, 1 cuadro, 60 ms)", () => {
  assert.equal(buildCodecHeader({ sampleRate: 16000, framesPerPacket: 1, frameSizeMs: 60 }), "gD4BPA==");
  assert.deepEqual(parseCodecHeader("gD4BPA=="), { sampleRate: 16000, framesPerPacket: 1, frameSizeMs: 60 });
});

test("parseOggPackets recupera los paquetes de buildOggOpus, también los de más de 255 bytes", () => {
  const a = new Uint8Array(700).map((_, i) => i % 251);
  a[0] = 3 << 3;
  const b = new Uint8Array(255).fill(5); // justo 255: necesita un segmento de largo 0 al final
  b[0] = 3 << 3;
  const c = new Uint8Array([3 << 3, 1, 2]);
  const ogg = buildOggOpus([a, b, c], { sampleRate: 16000, fallbackSamples: 2880 });
  const all = parseOggPackets(ogg);
  assert.equal(all.length, 5);
  const audio = oggOpusAudioPackets(ogg);
  assert.deepEqual(audio.map((p) => p.byteLength), [700, 255, 3]);
  assert.deepEqual([...audio[0]], [...a]);
  assert.deepEqual([...audio[1]], [...b]);
  assert.throws(() => parseOggPackets(new Uint8Array(40)), /Ogg/);
});
