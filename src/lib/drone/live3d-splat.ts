/**
 * Gaussian splats en vivo (binario "VGS1" de /splat, gpu/splat/LIVE3D.md), sin three.js (se
 * prueba con node). `parseLiveSplat` lo pasa al formato .splat de antimatter15 (32 bytes por
 * gaussiana), el mismo que ya abre el visor de Spark de la app.
 */

export interface LiveSplat {
  version: number;
  count: number;
  /** .splat: posición f32×3, escala f32×3, RGBA u8×4, rotación u8×4 (w,x,y,z). */
  splatBytes: Uint8Array;
}

const MAGIC = [0x56, 0x47, 0x53, 0x31]; // "VGS1"
const HEADER_BYTES = 44;
const SPLAT_BYTES = 32;

/** null si no calza con el formato (cabecera, largo). */
export function parseLiveSplat(buf: ArrayBuffer): LiveSplat | null {
  if (buf.byteLength < HEADER_BYTES) return null;
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < 4; i++) if (bytes[i] !== MAGIC[i]) return null;
  const dv = new DataView(buf);
  const version = dv.getUint32(4, true);
  const n = dv.getUint32(8, true);
  if (buf.byteLength < HEADER_BYTES + 17 * n) return null;
  const lo = [dv.getFloat32(12, true), dv.getFloat32(16, true), dv.getFloat32(20, true)];
  const hi = [dv.getFloat32(24, true), dv.getFloat32(28, true), dv.getFloat32(32, true)];
  const lmin = dv.getFloat32(36, true);
  const lmax = dv.getFloat32(40, true);
  const span = [(hi[0] - lo[0]) / 65535, (hi[1] - lo[1]) / 65535, (hi[2] - lo[2]) / 65535];
  // Tabla de las 256 escalas posibles: exp() una vez por valor, no por gaussiana.
  const scales = new Float32Array(256);
  for (let q = 0; q < 256; q++) scales[q] = Math.exp(lmin + (q / 255) * (lmax - lmin));

  const posOff = HEADER_BYTES;
  const scaleOff = posOff + n * 6;
  const rgbaOff = scaleOff + n * 3;
  const rotOff = rgbaOff + n * 4;
  const out = new Uint8Array(n * SPLAT_BYTES);
  const outF = new DataView(out.buffer);
  for (let i = 0; i < n; i++) {
    const o = i * SPLAT_BYTES;
    const p = posOff + i * 6;
    outF.setFloat32(o, lo[0] + dv.getUint16(p, true) * span[0], true);
    outF.setFloat32(o + 4, lo[1] + dv.getUint16(p + 2, true) * span[1], true);
    outF.setFloat32(o + 8, lo[2] + dv.getUint16(p + 4, true) * span[2], true);
    const s = scaleOff + i * 3;
    outF.setFloat32(o + 12, scales[bytes[s]], true);
    outF.setFloat32(o + 16, scales[bytes[s + 1]], true);
    outF.setFloat32(o + 20, scales[bytes[s + 2]], true);
    out.set(bytes.subarray(rgbaOff + i * 4, rgbaOff + i * 4 + 4), o + 24);
    out.set(bytes.subarray(rotOff + i * 4, rotOff + i * 4 + 4), o + 28);
  }
  return { version, count: n, splatBytes: out };
}
