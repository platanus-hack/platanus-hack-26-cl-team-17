/**
 * Piezas puras del protocolo de la Zello Channel API y del contenedor Ogg Opus.
 * Sin red ni estado: probado en protocol.test.ts.
 *
 * Zello entrega cada transmisión como:
 *   on_stream_start (JSON, con codec_header) → N paquetes binarios → on_stream_stop.
 * Cada paquete binario es [tipo:1][stream_id:4 BE][packet_id:4 BE][paquete Opus].
 * Los paquetes Opus se guardan tal cual dentro de un Ogg (audio/ogg), que los
 * navegadores reproducen y que el servicio de transcripción acepta: no hace falta
 * decodificar a PCM.
 *
 * Para hablar se hace al revés: ffmpeg codifica Opus dentro de un Ogg, se sacan los
 * paquetes (parseOggPackets) y se mandan con encodeZelloAudioPacket.
 */

/** Tipo de paquete binario de audio. */
export const ZELLO_PACKET_AUDIO = 0x01;

export interface ZelloAudioPacket {
  streamId: number;
  packetId: number;
  data: Uint8Array;
}

/** Lee un paquete binario de Zello; null si no es audio o viene truncado. */
export function parseZelloPacket(buf: Uint8Array): ZelloAudioPacket | null {
  if (buf.byteLength < 10 || buf[0] !== ZELLO_PACKET_AUDIO) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    streamId: view.getUint32(1, false),
    packetId: view.getUint32(5, false),
    data: buf.subarray(9),
  };
}

export interface ZelloCodecHeader {
  sampleRate: number;
  framesPerPacket: number;
  frameSizeMs: number;
}

/** Paquete binario de audio para mandar a Zello (packet_id va en cero, como pide la API). */
export function encodeZelloAudioPacket(streamId: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(9 + data.byteLength);
  const view = new DataView(out.buffer);
  out[0] = ZELLO_PACKET_AUDIO;
  view.setUint32(1, streamId >>> 0, false);
  view.setUint32(5, 0, false);
  out.set(data, 9);
  return out;
}

/** codec_header de on_stream_start: base64 de [frecuencia:2 LE][cuadros por paquete:1][ms por cuadro:1]. */
export function parseCodecHeader(b64: string | undefined): ZelloCodecHeader {
  const fallback = { sampleRate: 16000, framesPerPacket: 1, frameSizeMs: 60 };
  if (!b64) return fallback;
  const bytes = Buffer.from(b64, "base64");
  if (bytes.byteLength < 4) return fallback;
  return {
    sampleRate: bytes.readUInt16LE(0) || fallback.sampleRate,
    framesPerPacket: bytes[2] || 1,
    frameSizeMs: bytes[3] || fallback.frameSizeMs,
  };
}

/** codec_header para start_stream (inverso de parseCodecHeader). */
export function buildCodecHeader(h: ZelloCodecHeader): string {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt16LE(h.sampleRate, 0);
  bytes[2] = h.framesPerPacket;
  bytes[3] = h.frameSizeMs;
  return bytes.toString("base64");
}

/**
 * Duración de un paquete Opus en muestras a 48 kHz, leída de su byte TOC (RFC 6716 §3.1).
 * 0 si el paquete no se puede leer.
 */
export function opusPacketSamples(packet: Uint8Array): number {
  if (packet.byteLength < 1) return 0;
  const toc = packet[0];
  const config = toc >> 3;
  let frame: number;
  if (config < 12) frame = [480, 960, 1920, 2880][config % 4];
  else if (config < 16) frame = config % 2 === 0 ? 480 : 960;
  else frame = [120, 240, 480, 960][config % 4];
  const code = toc & 0x03;
  let frames: number;
  if (code === 0) frames = 1;
  else if (code === 1 || code === 2) frames = 2;
  else {
    if (packet.byteLength < 2) return 0;
    frames = packet[1] & 0x3f;
  }
  return frame * frames;
}

/* ─────────────── Ogg ─────────────── */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

/** CRC32 de Ogg (polinomio 0x04C11DB7, sin reflejar, valor inicial 0). */
export function oggCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < bytes.byteLength; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  return crc >>> 0;
}

/** Una página Ogg con un solo paquete. */
function oggPage(packet: Uint8Array, opts: { flags: number; granule: bigint; serial: number; seq: number }): Uint8Array {
  const lacing: number[] = [];
  let left = packet.byteLength;
  while (left >= 255) {
    lacing.push(255);
    left -= 255;
  }
  lacing.push(left);
  if (lacing.length > 255) throw new Error("Paquete Opus demasiado grande para una página Ogg.");

  const page = new Uint8Array(27 + lacing.length + packet.byteLength);
  const view = new DataView(page.buffer);
  page.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
  page[4] = 0; // versión
  page[5] = opts.flags;
  view.setBigInt64(6, opts.granule, true);
  view.setUint32(14, opts.serial, true);
  view.setUint32(18, opts.seq, true);
  // 22..25: CRC, se calcula con el campo en cero.
  page[26] = lacing.length;
  page.set(lacing, 27);
  page.set(packet, 27 + lacing.length);
  view.setUint32(22, oggCrc(page), true);
  return page;
}

function opusHead(sampleRate: number): Uint8Array {
  const head = new Uint8Array(19);
  const view = new DataView(head.buffer);
  head.set(new TextEncoder().encode("OpusHead"), 0);
  head[8] = 1; // versión
  head[9] = 1; // canales (Zello transmite mono)
  view.setUint16(10, 0, true); // pre-skip
  view.setUint32(12, sampleRate, true); // frecuencia original (informativa)
  view.setInt16(16, 0, true); // ganancia
  head[18] = 0; // mapeo de canales
  return head;
}

function opusTags(): Uint8Array {
  const vendor = new TextEncoder().encode("vigia-zello");
  const tags = new Uint8Array(8 + 4 + vendor.byteLength + 4);
  const view = new DataView(tags.buffer);
  tags.set(new TextEncoder().encode("OpusTags"), 0);
  view.setUint32(8, vendor.byteLength, true);
  tags.set(vendor, 12);
  view.setUint32(12 + vendor.byteLength, 0, true); // sin comentarios
  return tags;
}

/**
 * Arma un archivo Ogg Opus (audio/ogg) con los paquetes de una transmisión.
 * `fallbackSamples` se usa para los paquetes cuyo TOC no se puede leer.
 */
export function buildOggOpus(packets: Uint8Array[], opts: { sampleRate: number; fallbackSamples: number; serial?: number }): Uint8Array {
  const serial = opts.serial ?? 0x5a454c4c; // "ZELL"
  const pages: Uint8Array[] = [
    oggPage(opusHead(opts.sampleRate), { flags: 0x02, granule: BigInt(0), serial, seq: 0 }),
    oggPage(opusTags(), { flags: 0, granule: BigInt(0), serial, seq: 1 }),
  ];
  let granule = BigInt(0);
  packets.forEach((p, i) => {
    granule += BigInt(opusPacketSamples(p) || opts.fallbackSamples);
    const last = i === packets.length - 1;
    pages.push(oggPage(p, { flags: last ? 0x04 : 0, granule, serial, seq: i + 2 }));
  });
  const total = pages.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of pages) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

/** Duración total en segundos de los paquetes de una transmisión. */
export function opusDurationSeconds(packets: Uint8Array[], fallbackSamples: number): number {
  return packets.reduce((n, p) => n + (opusPacketSamples(p) || fallbackSamples), 0) / 48_000;
}

/**
 * Paquetes de un flujo Ogg (une los que cruzan páginas). Para Ogg Opus, los dos
 * primeros son OpusHead y OpusTags. Lanza si el archivo no es Ogg.
 */
export function parseOggPackets(ogg: Uint8Array): Uint8Array[] {
  const packets: Uint8Array[] = [];
  let partial: Uint8Array[] = [];
  let off = 0;
  while (off + 27 <= ogg.byteLength) {
    if (ogg[off] !== 0x4f || ogg[off + 1] !== 0x67 || ogg[off + 2] !== 0x67 || ogg[off + 3] !== 0x53) {
      throw new Error("No es un flujo Ogg válido.");
    }
    const nseg = ogg[off + 26];
    const lacing = ogg.subarray(off + 27, off + 27 + nseg);
    let body = off + 27 + nseg;
    for (const len of lacing) {
      partial.push(ogg.subarray(body, body + len));
      body += len;
      if (len < 255) {
        const total = partial.reduce((n, p) => n + p.byteLength, 0);
        const packet = new Uint8Array(total);
        let o = 0;
        for (const p of partial) {
          packet.set(p, o);
          o += p.byteLength;
        }
        packets.push(packet);
        partial = [];
      }
    }
    off = body;
  }
  return packets;
}

/** Paquetes de audio de un Ogg Opus (sin OpusHead ni OpusTags). */
export function oggOpusAudioPackets(ogg: Uint8Array): Uint8Array[] {
  const tag = (p: Uint8Array, s: string) => new TextDecoder().decode(p.subarray(0, 8)) === s;
  return parseOggPackets(ogg).filter((p) => !tag(p, "OpusHead") && !tag(p, "OpusTags"));
}
