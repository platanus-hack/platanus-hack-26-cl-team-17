/**
 * Nube de puntos de la reconstrucción 3D en vivo, sin three.js (se prueba con node).
 *
 * - `parseLive3dChunk`: lee el binario "VL3D" de /points (gpu/splat/LIVE3D.md).
 * - `PointCloudBuffer`: arreglos que crecen al doble (posiciones Float32, colores Uint8) y una
 *   muestra chica de puntos para encuadrar la cámara sin recorrer toda la nube.
 * - Utilidades de matrices: centro y frustum de cada cámara, encuadre robusto.
 */

export interface Live3DChunk {
  from: number;
  /** Exclusivo. */
  to: number;
  count: number;
  /** x,y,z en el sistema del mundo. */
  positions: Float32Array;
  /** r,g,b 0..255. */
  colors: Uint8Array;
}

const MAGIC = [0x56, 0x4c, 0x33, 0x44]; // "VL3D"
const HEADER_BYTES = 16;
const LITTLE_ENDIAN_HOST = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** Lee un bloque de /points. null si no calza con el formato (cabecera, largo). */
export function parseLive3dChunk(buf: ArrayBuffer): Live3DChunk | null {
  if (buf.byteLength < HEADER_BYTES) return null;
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < 4; i++) if (bytes[i] !== MAGIC[i]) return null;
  const dv = new DataView(buf);
  const from = dv.getUint32(4, true);
  const to = dv.getUint32(8, true);
  const count = dv.getUint32(12, true);
  if (to < from) return null;
  const posBytes = count * 12;
  if (buf.byteLength < HEADER_BYTES + posBytes + count * 3) return null;
  let positions: Float32Array;
  if (LITTLE_ENDIAN_HOST) {
    // Copia: el bloque se descarta y la nube guarda sus propios arreglos.
    positions = new Float32Array(buf.slice(HEADER_BYTES, HEADER_BYTES + posBytes));
  } else {
    positions = new Float32Array(count * 3);
    for (let i = 0; i < count * 3; i++) positions[i] = dv.getFloat32(HEADER_BYTES + i * 4, true);
  }
  const colors = bytes.slice(HEADER_BYTES + posBytes, HEADER_BYTES + posBytes + count * 3);
  return { from, to, count, positions, colors };
}

/** Puntos de muestra para el encuadre (posiciones del mundo). */
const MAX_SAMPLES = 6000;
/** Muestra por bloque agregado: entre 400 y 3000 puntos según su tamaño. */
const samplesFor = (n: number) => Math.min(3000, Math.max(400, Math.floor(n / 200)));
const INITIAL_CAPACITY = 1 << 16;

/** Nube que crece: se agregan trozos y los arreglos se duplican cuando no caben. */
export class PointCloudBuffer {
  positions = new Float32Array(INITIAL_CAPACITY * 3);
  colors = new Uint8Array(INITIAL_CAPACITY * 3);
  count = 0;
  /** Sube cada vez que se reemplazan los arreglos (crecieron o se vació la nube). */
  generation = 0;
  /** Muestra de posiciones (x,y,z seguidas) para encuadrar. */
  samples: number[] = [];

  get capacity(): number {
    return this.positions.length / 3;
  }

  /** Agrega puntos; devuelve el índice del primero agregado. */
  append(positions: Float32Array, colors: Uint8Array): number {
    const n = Math.min(Math.floor(positions.length / 3), Math.floor(colors.length / 3));
    const start = this.count;
    if (n === 0) return start;
    if (start + n > this.capacity) {
      let cap = this.capacity;
      while (cap < start + n) cap *= 2;
      const p = new Float32Array(cap * 3);
      p.set(this.positions.subarray(0, start * 3));
      const c = new Uint8Array(cap * 3);
      c.set(this.colors.subarray(0, start * 3));
      this.positions = p;
      this.colors = c;
      this.generation++;
    }
    this.positions.set(positions.subarray(0, n * 3), start * 3);
    this.colors.set(colors.subarray(0, n * 3), start * 3);
    this.count = start + n;

    const step = Math.max(1, Math.floor(n / samplesFor(n)));
    for (let i = 0; i < n; i += step) {
      const x = positions[i * 3];
      const y = positions[i * 3 + 1];
      const z = positions[i * 3 + 2];
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) this.samples.push(x, y, z);
    }
    if (this.samples.length > MAX_SAMPLES * 3) {
      // Se queda con uno de cada dos (sigue representando toda la nube).
      const kept: number[] = [];
      for (let i = 0; i < this.samples.length; i += 6) kept.push(this.samples[i], this.samples[i + 1], this.samples[i + 2]);
      this.samples = kept;
    }
    return start;
  }

  reset(): void {
    this.positions = new Float32Array(INITIAL_CAPACITY * 3);
    this.colors = new Uint8Array(INITIAL_CAPACITY * 3);
    this.count = 0;
    this.samples = [];
    this.generation++;
  }
}

/** Aplica una matriz 4x4 por filas a un punto. */
export function applyRowMajor4(m: readonly number[], x: number, y: number, z: number): [number, number, number] {
  const w = m[12] * x + m[13] * y + m[14] * z + m[15] || 1;
  return [
    (m[0] * x + m[1] * y + m[2] * z + m[3]) / w,
    (m[4] * x + m[5] * y + m[6] * z + m[7]) / w,
    (m[8] * x + m[9] * y + m[10] * z + m[11]) / w,
  ];
}

/** Escala uniforme aproximada de la matriz (raíz cúbica del determinante del bloque 3x3). */
export function matrixScale(m: readonly number[]): number {
  const det =
    m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);
  const s = Math.cbrt(Math.abs(det));
  return Number.isFinite(s) && s > 1e-9 ? s : 1;
}

/** Centro de la cámara de una c2w 3x4 por filas (columna de traslación). */
export function cameraCenter(c2w: readonly number[]): [number, number, number] {
  return [c2w[3], c2w[7], c2w[11]];
}

/**
 * Segmentos (pares de puntos) de un frustum en el mundo: pirámide desde el centro hasta un
 * rectángulo a `depth` hacia adelante (OpenCV: x derecha, y abajo, z adelante), más una marca
 * arriba del rectángulo para ver hacia dónde está "arriba" en la imagen.
 */
export function frustumSegments(c2w: readonly number[], depth: number, aspect = 4 / 3): [number, number, number][] {
  const c = cameraCenter(c2w);
  const col = (j: number): [number, number, number] => [c2w[j], c2w[4 + j], c2w[8 + j]];
  const [rx, ry, rz] = [col(0), col(1), col(2)];
  const hw = depth * 0.5;
  const hh = hw / aspect;
  const at = (sx: number, sy: number, sz: number): [number, number, number] => [
    c[0] + rx[0] * sx + ry[0] * sy + rz[0] * sz,
    c[1] + rx[1] * sx + ry[1] * sy + rz[1] * sz,
    c[2] + rx[2] * sx + ry[2] * sy + rz[2] * sz,
  ];
  const tl = at(-hw, -hh, depth);
  const tr = at(hw, -hh, depth);
  const br = at(hw, hh, depth);
  const bl = at(-hw, hh, depth);
  const tip = at(0, -hh * 1.7, depth);
  return [c, tl, c, tr, c, br, c, bl, tl, tr, tr, br, br, bl, bl, tl, tl, tip, tip, tr];
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[i];
}

/**
 * Encuadre robusto en coordenadas de vista: caja entre los percentiles 3 y 97 de la muestra
 * (los puntos sueltos lejanos no alejan la cámara). null sin muestra.
 */
export function robustBounds(
  samples: readonly number[],
  display: readonly number[],
): { center: [number, number, number]; radius: number } | null {
  const n = Math.floor(samples.length / 3);
  if (n === 0) return null;
  const xs: number[] = new Array(n);
  const ys: number[] = new Array(n);
  const zs: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const [x, y, z] = applyRowMajor4(display, samples[i * 3], samples[i * 3 + 1], samples[i * 3 + 2]);
    xs[i] = x;
    ys[i] = y;
    zs[i] = z;
  }
  const lo = 0.03;
  const hi = 0.97;
  const box = [xs, ys, zs].map((a) => {
    a.sort((p, q) => p - q);
    return [percentile(a, lo), percentile(a, hi)] as const;
  });
  const center: [number, number, number] = [(box[0][0] + box[0][1]) / 2, (box[1][0] + box[1][1]) / 2, (box[2][0] + box[2][1]) / 2];
  const radius = Math.hypot(box[0][1] - box[0][0], box[1][1] - box[1][0], box[2][1] - box[2][0]) / 2;
  return { center, radius: Math.max(radius, 0.05) };
}
