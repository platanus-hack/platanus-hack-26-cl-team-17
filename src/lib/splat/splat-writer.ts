/**
 * Escritor del formato .splat de antimatter15: 32 bytes por gaussiana, little-endian.
 *   0..11  posición  float32 × 3
 *   12..23 escala lineal (desviación estándar) float32 × 3
 *   24..27 color RGBA uint8 × 4 (A = opacidad)
 *   28..31 rotación uint8 × 4 en orden w, x, y, z, codificada como q·128 + 128
 */
export const SPLAT_BYTES = 32;

export interface Gaussian {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  /** 0..255 */
  r: number;
  g: number;
  b: number;
  /** Opacidad 0..1 */
  a: number;
  /** Cuaternión unitario (se normaliza al escribir). Por defecto identidad. */
  qw?: number;
  qx?: number;
  qy?: number;
  qz?: number;
}

const byte = (v: number) => (Number.isFinite(v) ? Math.min(255, Math.max(0, Math.round(v))) : 0);
const finite = (v: number) => (Number.isFinite(v) ? v : 0);

export class SplatWriter {
  private buf: Uint8Array;
  private view: DataView;
  private n = 0;

  constructor(initialCapacity = 4096) {
    this.buf = new Uint8Array(Math.max(1, initialCapacity) * SPLAT_BYTES);
    this.view = new DataView(this.buf.buffer);
  }

  get count(): number {
    return this.n;
  }

  private ensure(extra: number) {
    const need = (this.n + extra) * SPLAT_BYTES;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.n * SPLAT_BYTES));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  push(g: Gaussian): void {
    this.ensure(1);
    const o = this.n * SPLAT_BYTES;
    const v = this.view;
    v.setFloat32(o, finite(g.x), true);
    v.setFloat32(o + 4, finite(g.y), true);
    v.setFloat32(o + 8, finite(g.z), true);
    v.setFloat32(o + 12, Math.max(1e-4, finite(g.sx)), true);
    v.setFloat32(o + 16, Math.max(1e-4, finite(g.sy)), true);
    v.setFloat32(o + 20, Math.max(1e-4, finite(g.sz)), true);
    this.buf[o + 24] = byte(g.r);
    this.buf[o + 25] = byte(g.g);
    this.buf[o + 26] = byte(g.b);
    this.buf[o + 27] = byte(g.a * 255);
    let qw = g.qw ?? 1;
    let qx = g.qx ?? 0;
    let qy = g.qy ?? 0;
    let qz = g.qz ?? 0;
    const len = Math.hypot(qw, qx, qy, qz);
    if (!Number.isFinite(len) || len < 1e-9) {
      qw = 1;
      qx = qy = qz = 0;
    } else {
      qw /= len;
      qx /= len;
      qy /= len;
      qz /= len;
    }
    this.buf[o + 28] = byte(qw * 128 + 128);
    this.buf[o + 29] = byte(qx * 128 + 128);
    this.buf[o + 30] = byte(qy * 128 + 128);
    this.buf[o + 31] = byte(qz * 128 + 128);
    this.n += 1;
  }

  /** Copia exacta de lo escrito (n × 32 bytes). */
  toBytes(): Uint8Array {
    return this.buf.slice(0, this.n * SPLAT_BYTES);
  }
}

export interface DecodedGaussian {
  position: [number, number, number];
  scale: [number, number, number];
  rgba: [number, number, number, number];
  /** w, x, y, z en −1..1 (cuantizado) */
  rotation: [number, number, number, number];
}

/** Lee la gaussiana `index` de un archivo .splat (para pruebas y validación). */
export function decodeSplat(bytes: Uint8Array, index: number): DecodedGaussian {
  const o = index * SPLAT_BYTES;
  if (o < 0 || o + SPLAT_BYTES > bytes.length) throw new RangeError("Índice fuera del archivo .splat");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const f = (k: number) => v.getFloat32(o + k, true);
  const q = (k: number) => (bytes[o + k] - 128) / 128;
  return {
    position: [f(0), f(4), f(8)],
    scale: [f(12), f(16), f(20)],
    rgba: [bytes[o + 24], bytes[o + 25], bytes[o + 26], bytes[o + 27]],
    rotation: [q(28), q(29), q(30), q(31)],
  };
}
