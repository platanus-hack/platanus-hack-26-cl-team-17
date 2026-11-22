/**
 * Binario "VL3D", nube que crece y utilidades de la reconstrucción 3D en vivo.
 *   node --import tsx --test src/lib/drone/live3d-points.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyRowMajor4,
  cameraCenter,
  frustumSegments,
  matrixScale,
  parseLive3dChunk,
  PointCloudBuffer,
  robustBounds,
} from "./live3d-points";
import { IDENTITY_4X4, LIVE3D_SESSION_RE, parseLive3dStatus } from "./live3d-types";

function encode(from: number, to: number, pts: number[][], rgb: number[][]): ArrayBuffer {
  const n = pts.length;
  const buf = new ArrayBuffer(16 + n * 12 + n * 3);
  const dv = new DataView(buf);
  [0x56, 0x4c, 0x33, 0x44].forEach((b, i) => dv.setUint8(i, b));
  dv.setUint32(4, from, true);
  dv.setUint32(8, to, true);
  dv.setUint32(12, n, true);
  pts.forEach((p, i) => p.forEach((v, j) => dv.setFloat32(16 + (i * 3 + j) * 4, v, true)));
  rgb.forEach((c, i) => c.forEach((v, j) => dv.setUint8(16 + n * 12 + i * 3 + j, v)));
  return buf;
}

test("parseLive3dChunk lee cabecera, posiciones y colores", () => {
  const chunk = parseLive3dChunk(encode(3, 5, [[1, 2, 3], [-0.5, 0, 9]], [[255, 0, 10], [1, 2, 3]]));
  assert.ok(chunk);
  assert.equal(chunk.from, 3);
  assert.equal(chunk.to, 5);
  assert.equal(chunk.count, 2);
  assert.deepEqual(Array.from(chunk.positions), [1, 2, 3, -0.5, 0, 9]);
  assert.deepEqual(Array.from(chunk.colors), [255, 0, 10, 1, 2, 3]);
});

test("parseLive3dChunk acepta un bloque vacío y rechaza lo que no calza", () => {
  const empty = parseLive3dChunk(encode(4, 4, [], []));
  assert.ok(empty);
  assert.equal(empty.count, 0);
  assert.equal(parseLive3dChunk(new ArrayBuffer(8)), null);
  const bad = encode(0, 1, [[1, 2, 3]], [[1, 2, 3]]);
  new Uint8Array(bad)[0] = 0x41;
  assert.equal(parseLive3dChunk(bad), null);
  // Truncado: dice 1 punto pero faltan los colores.
  assert.equal(parseLive3dChunk(encode(0, 1, [[1, 2, 3]], [[1, 2, 3]]).slice(0, 16 + 12)), null);
  // to < from
  assert.equal(parseLive3dChunk(encode(5, 2, [], [])), null);
});

test("PointCloudBuffer duplica la capacidad y conserva lo anterior", () => {
  const cloud = new PointCloudBuffer();
  const cap0 = cloud.capacity;
  const gen0 = cloud.generation;
  const n = cap0 - 10;
  const pos = new Float32Array(n * 3).map((_, i) => i);
  const col = new Uint8Array(n * 3).fill(7);
  assert.equal(cloud.append(pos, col), 0);
  assert.equal(cloud.count, n);
  assert.equal(cloud.generation, gen0);
  const start = cloud.append(new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].concat(new Array(30 * 3).fill(0))), new Uint8Array(32 * 3).fill(9));
  assert.equal(start, n);
  assert.equal(cloud.count, n + 32);
  assert.equal(cloud.capacity, cap0 * 2);
  assert.equal(cloud.generation, gen0 + 1);
  assert.equal(cloud.positions[5], 5);
  assert.deepEqual(Array.from(cloud.positions.subarray(n * 3, n * 3 + 3)), [1, 2, 3]);
  assert.equal(cloud.colors[n * 3], 9);
  assert.ok(cloud.samples.length > 0 && cloud.samples.length % 3 === 0);
  cloud.reset();
  assert.equal(cloud.count, 0);
  assert.equal(cloud.samples.length, 0);
});

test("la muestra para encuadrar queda acotada", () => {
  const cloud = new PointCloudBuffer();
  for (let k = 0; k < 40; k++) cloud.append(new Float32Array(3000 * 3).fill(k), new Uint8Array(3000 * 3));
  assert.ok(cloud.samples.length / 3 <= 6000);
  assert.equal(cloud.count, 40 * 3000);
});

test("matrices: aplicar, escala, centro y frustum", () => {
  const m = [2, 0, 0, 1, 0, 2, 0, 0, 0, 0, 2, -1, 0, 0, 0, 1];
  assert.deepEqual(applyRowMajor4(m, 1, 1, 1), [3, 2, 1]);
  assert.ok(Math.abs(matrixScale(m) - 2) < 1e-9);
  assert.equal(matrixScale([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]), 1);
  const c2w = [1, 0, 0, 10, 0, 1, 0, 20, 0, 0, 1, 30];
  assert.deepEqual(cameraCenter(c2w), [10, 20, 30]);
  const seg = frustumSegments(c2w, 1);
  assert.equal(seg.length % 2, 0);
  assert.deepEqual(seg[0], [10, 20, 30]);
  // Esquina superior izquierda: x -0,5, y negativa (arriba en OpenCV), z +1.
  assert.equal(seg[1][0], 9.5);
  assert.ok(seg[1][1] < 20);
  assert.equal(seg[1][2], 31);
});

test("robustBounds ignora puntos sueltos lejanos", () => {
  const s: number[] = [];
  for (let i = 0; i < 1000; i++) s.push((i % 10) / 10, 0, Math.floor(i / 100) / 10);
  s.push(1000, 1000, 1000);
  const b = robustBounds(s, IDENTITY_4X4);
  assert.ok(b);
  assert.ok(b.radius < 1);
  assert.ok(Math.abs(b.center[0] - 0.45) < 0.1);
  assert.equal(robustBounds([], IDENTITY_4X4), null);
});

test("parseLive3dStatus valida y completa", () => {
  assert.equal(parseLive3dStatus(null), null);
  assert.equal(parseLive3dStatus({ engine: "fake" }), null);
  const st = parseLive3dStatus({
    session: "m_1",
    engine: "fake",
    ready: true,
    state: "running",
    message: "",
    version: 3,
    chunks: 2,
    points: 1200,
    keyframes: 5,
    frames_received: 40,
    pending: 1,
    last_chunk_ms: 300,
    updated_at: 1763770000000,
    display: [1, 2, 3],
    cameras: [[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], [1, 2]],
  });
  assert.ok(st);
  assert.equal(st.state, "running");
  assert.equal(st.message, null);
  assert.deepEqual(st.display, [...IDENTITY_4X4]);
  assert.equal(st.cameras.length, 1);
  assert.equal(parseLive3dStatus({ session: "x", state: "rara" })?.state, "waiting");
  assert.ok(LIVE3D_SESSION_RE.test("6f1c2d9e-0b7a-4c55-9a1e-3b2f8c7d6e5a"));
  assert.ok(!LIVE3D_SESSION_RE.test("../x"));
});
