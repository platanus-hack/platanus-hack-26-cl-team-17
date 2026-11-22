/**
 * Binario "VGS1" de los Gaussian splats en vivo → .splat.
 *   node --import tsx --test src/lib/drone/live3d-splat.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLiveSplat } from "./live3d-splat";
import { parseLive3dStatus } from "./live3d-types";

// Generado con encode_live_splat (gpu/splat/splat/live_gs.py), versión 42, 3 gaussianas, en orden de importancia.
const FIXTURE =
  "VkdTMSoAAAADAAAAEM+SvAPOEr3ScEPAPEuCPzhLAkB/NFw9AABAwAAAgL//fwCAAIBuBG4EkfuR+5H7bgS/v7+AgID/AEAF+oC6gICA88c4o4CAgID//4CAgMDAwMA=";

function bufferOf(b64: string): ArrayBuffer {
  const bytes = Uint8Array.from(Buffer.from(b64, "base64"));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

test("parseLiveSplat decodifica lo que escribe el servicio", () => {
  const s = parseLiveSplat(bufferOf(FIXTURE));
  assert.ok(s);
  assert.equal(s.version, 42);
  assert.equal(s.count, 3);
  assert.equal(s.splatBytes.length, 3 * 32);
  const dv = new DataView(s.splatBytes.buffer);
  const f = (i: number, k: number) => dv.getFloat32(i * 32 + k * 4, true);
  const expected = [
    { pos: [0.5, 1, -1.5], scale: [0.22269, 0.22269, 0.22269], rgba: [5, 250, 128, 186], rot: [128, 128, 128, 255] },
    { pos: [0, 0, 0], scale: [0.13587, 0.13587, 0.13587], rgba: [128, 128, 128, 243], rot: [255, 128, 128, 128] },
    { pos: [1, 2, -3], scale: [0.36788, 0.04979, 0.08225], rgba: [199, 56, 163, 128], rot: [192, 192, 192, 192] },
  ];
  expected.forEach((e, i) => {
    e.pos.forEach((v, k) => assert.ok(Math.abs(f(i, k) - v) < 1e-3, `pos ${i},${k}: ${f(i, k)}`));
    e.scale.forEach((v, k) => assert.ok(Math.abs(f(i, 3 + k) - v) < 1e-4, `escala ${i},${k}: ${f(i, 3 + k)}`));
    assert.deepEqual(Array.from(s.splatBytes.subarray(i * 32 + 24, i * 32 + 28)), e.rgba);
    assert.deepEqual(Array.from(s.splatBytes.subarray(i * 32 + 28, i * 32 + 32)), e.rot);
  });
});

test("parseLiveSplat rechaza lo que no calza", () => {
  assert.equal(parseLiveSplat(new ArrayBuffer(10)), null);
  const bad = bufferOf(FIXTURE);
  new Uint8Array(bad)[0] = 0;
  assert.equal(parseLiveSplat(bad), null);
  assert.equal(parseLiveSplat(bufferOf(FIXTURE).slice(0, 60)), null);
});

test("parseLive3dStatus lee el estado de los splats", () => {
  const st = parseLive3dStatus({
    session: "m1",
    splat: { engine: "gsplat", active: true, version: 3, gaussians: 1200.7, training: 1500, steps: 90, views: 12, psnr: 21.5, updated_at: 5, error: " " },
  });
  assert.ok(st?.splat);
  assert.equal(st.splat.engine, "gsplat");
  assert.equal(st.splat.active, true);
  assert.equal(st.splat.gaussians, 1200);
  assert.equal(st.splat.error, null);
  assert.equal(parseLive3dStatus({ session: "m1" })?.splat, null);
});
