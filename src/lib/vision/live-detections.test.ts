/**
 * Funciones puras del video en vivo con detector (conteos, filtro y sincronía por seq).
 *   node --import tsx --test src/lib/vision/live-detections.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  detectionCountsLine,
  hasCritical,
  mergeLiveDetections,
  overlayDetections,
  pickDetectionForSeq,
  type LiveDetection,
} from "./live-detections";
import type { DetectResult, Detection } from "./types";

const d = (label: string, conf: number): Detection => ({
  label,
  conf,
  box: [0, 0, 0.1, 0.1],
  zone: { h: "centro", v: "medio" },
  pose: null,
});
const res = (dets: Detection[]): DetectResult => ({ width: 640, height: 360, ms: 50, detections: dets, counts: {} });
const live = (seq: number): LiveDetection => ({ seq, at: new Date(seq).toISOString(), result: res([d("persona", 0.9)]) });

test("detectionCountsLine: lo crítico primero, plurales y sin número para el humo", () => {
  assert.equal(detectionCountsLine([d("auto", 0.9), d("persona", 0.8), d("humo", 0.3), d("persona", 0.7)]), "2 personas · humo · 1 auto");
  assert.equal(detectionCountsLine([d("cilindro_gas", 0.5), d("cilindro_gas", 0.4)]), "2 cilindros de gas");
  assert.equal(detectionCountsLine([d("cable_caido", 0.5)]), "1 cable caído");
  assert.equal(detectionCountsLine([]), "");
  assert.equal(
    detectionCountsLine([d("persona", 1), d("fuego", 1), d("humo", 1), d("auto", 1), d("bus", 1)], 3),
    "1 persona · fuego · humo · +2",
  );
});

test("overlayDetections: deja peligros desde 15 % y el resto desde 30 %", () => {
  const out = overlayDetections(res([d("humo", 0.16), d("fuego", 0.1), d("persona", 0.29), d("auto", 0.31), d("persona", 0.8)]));
  assert.deepEqual(
    out.map((x) => `${x.label}:${x.conf}`),
    ["humo:0.16", "auto:0.31", "persona:0.8"],
  );
  assert.equal(hasCritical(out), true);
  assert.equal(hasCritical([d("auto", 0.9)]), false);
});

test("pickDetectionForSeq: el mismo cuadro, si no el anterior más cercano dentro del margen", () => {
  const list = [live(1000), live(1300), live(1700)];
  assert.equal(pickDetectionForSeq(list, 1300)?.seq, 1300);
  assert.equal(pickDetectionForSeq(list, 1600)?.seq, 1300, "aún no llega la del cuadro mostrado");
  assert.equal(pickDetectionForSeq(list, 900)?.seq, 1000, "sin anterior, la siguiente cercana");
  assert.equal(pickDetectionForSeq(list, 5000), null, "demasiado vieja: no se dibuja");
  assert.equal(pickDetectionForSeq([], 1000), null);
});

test("mergeLiveDetections: sin duplicar seq, en orden y con tope", () => {
  const merged = mergeLiveDetections([live(1), live(3)], [live(2), live(3), live(4)], 3);
  assert.deepEqual(
    merged.map((x) => x.seq),
    [2, 3, 4],
  );
});
