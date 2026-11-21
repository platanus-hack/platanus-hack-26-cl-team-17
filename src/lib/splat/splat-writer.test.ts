import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeSplat, SPLAT_BYTES, SplatWriter } from "./splat-writer";
import { buildSyntheticSplat, quatFromBasis } from "./synthetic";
import { SCENE } from "./test-fixtures";

test("32 bytes por gaussiana, little-endian, en el orden de antimatter15", () => {
  const w = new SplatWriter(1);
  w.push({ x: 1.5, y: -2.25, z: 3, sx: 0.5, sy: 0.25, sz: 0.125, r: 255, g: 128, b: 0, a: 0.5 });
  const bytes = w.toBytes();
  assert.equal(SPLAT_BYTES, 32);
  assert.equal(bytes.length, 32);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(v.getFloat32(0, true), 1.5);
  assert.equal(v.getFloat32(4, true), -2.25);
  assert.equal(v.getFloat32(8, true), 3);
  assert.equal(v.getFloat32(12, true), 0.5);
  assert.equal(v.getFloat32(16, true), 0.25);
  assert.equal(v.getFloat32(20, true), 0.125);
  assert.deepEqual([...bytes.subarray(24, 28)], [255, 128, 0, 128], "RGBA con A = opacidad × 255");
  assert.deepEqual([...bytes.subarray(28, 32)], [255, 128, 128, 128], "identidad: w = 1 → 255, x/y/z = 0 → 128");
});

test("normaliza el cuaternión y lo cuantiza como q·128 + 128 en orden w, x, y, z", () => {
  const w = new SplatWriter();
  // Rotación de 90° en z sin normalizar: (w, z) = (2, 2) → (0,707, 0,707).
  w.push({ x: 0, y: 0, z: 0, sx: 1, sy: 1, sz: 1, r: 0, g: 0, b: 0, a: 1, qw: 2, qx: 0, qy: 0, qz: 2 });
  const d = decodeSplat(w.toBytes(), 0);
  const q = Math.round(Math.SQRT1_2 * 128 + 128);
  assert.deepEqual([...w.toBytes().subarray(28, 32)], [q, 128, 128, q]);
  assert.ok(Math.abs(d.rotation[0] - Math.SQRT1_2) < 0.01);
  assert.ok(Math.abs(d.rotation[3] - Math.SQRT1_2) < 0.01);
});

test("acota valores fuera de rango y crece más allá de la capacidad inicial", () => {
  const w = new SplatWriter(2);
  for (let i = 0; i < 1000; i++) {
    w.push({ x: i, y: NaN, z: 0, sx: 0, sy: -1, sz: 2, r: 300, g: -5, b: 12.4, a: 2 });
  }
  assert.equal(w.count, 1000);
  const bytes = w.toBytes();
  assert.equal(bytes.length, 1000 * SPLAT_BYTES);
  const last = decodeSplat(bytes, 999);
  assert.equal(last.position[0], 999);
  assert.equal(last.position[1], 0, "NaN se escribe como 0");
  assert.ok(last.scale[0] > 0 && last.scale[1] > 0, "escala mínima positiva");
  assert.deepEqual(last.rgba, [255, 0, 12, 255]);
  assert.throws(() => decodeSplat(bytes, 1000), RangeError);
});

test("quatFromBasis lleva los ejes locales a la base pedida", () => {
  const rotate = ([w, x, y, z]: number[], v: number[]) => {
    // v' = q v q*
    const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
    return [
      v[0] + w * t[0] + (y * t[2] - z * t[1]),
      v[1] + w * t[1] + (z * t[0] - x * t[2]),
      v[2] + w * t[2] + (x * t[1] - y * t[0]),
    ];
  };
  const bases: [number, number, number][][] = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[0, -1, 0], [0, 0, 1], [-1, 0, 0]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [-1, 0, 0], [0, 0, 1]],
  ];
  for (const [u, v, n] of bases) {
    const q = quatFromBasis(u, v, n);
    assert.ok(Math.abs(Math.hypot(...q) - 1) < 1e-9);
    for (const [axis, want] of [
      [[1, 0, 0], u],
      [[0, 1, 0], v],
      [[0, 0, 1], n],
    ] as const) {
      const got = rotate(q, [...axis]);
      got.forEach((g, i) => assert.ok(Math.abs(g - want[i]) < 1e-9, `${JSON.stringify({ u, v, n, got })}`));
    }
  }
});

test("vista sintética: archivo .splat válido, determinista y con cada capa de la escena", () => {
  const a = buildSyntheticSplat(SCENE);
  const b = buildSyntheticSplat(SCENE);
  assert.equal(a.bytes.length, a.count * SPLAT_BYTES);
  assert.ok(a.count > 20_000 && a.count < 150_000, `cantidad razonable (${a.count})`);
  assert.deepEqual(a.bytes, b.bytes, "misma escena → mismo archivo");

  let fire = 0;
  let person = 0;
  let aboveGround = 0;
  let maxR = 0;
  for (let i = 0; i < a.count; i++) {
    const g = decodeSplat(a.bytes, i);
    for (const v of [...g.position, ...g.scale]) assert.ok(Number.isFinite(v));
    const [r, gr, bl] = g.rgba;
    if (r > 240 && gr > 100 && gr < 250 && bl < 190 && g.position[2] > 1) fire++;
    if (r === 255 && gr === 58 && bl === 108) person++;
    if (g.position[2] > 0.5) aboveGround++;
    maxR = Math.max(maxR, Math.hypot(g.position[0], g.position[1]));
  }
  assert.ok(fire > 500, `hay fuego (${fire})`);
  assert.ok(person > 20, `hay marcador de persona en ventana (${person})`);
  assert.ok(aboveGround > 5_000, "estructuras y humo sobre el suelo");
  assert.ok(maxR <= a.ground_radius_m + 40, "nada lejísimos del origen");
});

test("vista sintética de una escena vacía: solo suelo", () => {
  const empty = buildSyntheticSplat({
    ...SCENE,
    roads: [],
    structures: [],
    fire_zones: [],
    smoke_plumes: [],
    people: [],
    vehicles: [],
    hazards: [],
  });
  assert.ok(empty.count > 1000);
  assert.equal(empty.ground_radius_m, 30);
});
