/**
 * Texto de detecciones del observador en vivo (camino con detector).
 *   node --import tsx --test src/lib/ai/live-detections.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DetectResult } from "@/lib/vision/types";
import { LIVE_DETECTOR_SYSTEM_PROMPT, LIVE_SYSTEM_PROMPT, buildLiveDetectionText } from "./live";

const res = (labels: string[]): DetectResult => {
  const counts: Record<string, number> = {};
  for (const l of labels) counts[l] = (counts[l] ?? 0) + 1;
  return {
    width: 640,
    height: 360,
    ms: 40,
    counts,
    detections: labels.map((label) => ({ label, conf: 0.8, box: [0, 0, 0.2, 0.2], zone: { h: "centro", v: "bajo" }, pose: null })),
  };
};

test("buildLiveDetectionText: hasta 8 cuadros repartidos (con el último) y resumen de la ventana", () => {
  const results = Array.from({ length: 20 }, (_, i) => ({ ago_s: 19 - i, result: res(i % 2 ? ["persona", "persona"] : ["auto"]) }));
  const text = buildLiveDetectionText({ results, annotated: true });
  const lines = text.split("\n").filter((l) => /^(hace \d+ s|último cuadro):/.test(l));
  assert.equal(lines.length, 8);
  assert.match(lines[0], /^hace 19 s: auto 80 % \(bajo, centro\)/);
  assert.match(lines[7], /^último cuadro: persona 80 %/);
  assert.match(text, /YOLO\) en 20 cuadros/);
  assert.match(text, /- persona: hasta 2 a la vez · confianza máx\. 80 % · en 10 de 20 cuadros/);
  assert.ok(LIVE_DETECTOR_SYSTEM_PROMPT.startsWith(LIVE_SYSTEM_PROMPT));
});

test("buildLiveDetectionText: sin detecciones y con etiquetas raras no rompe el formato", () => {
  const text = buildLiveDetectionText({ results: [{ ago_s: 0, result: res(["<x>\nfin"]) }], annotated: false });
  assert.ok(!text.includes("<x>"));
  assert.equal(text.split("\n").filter((l) => l.startsWith("último cuadro:")).length, 1);
  assert.match(buildLiveDetectionText({ results: [{ ago_s: 0, result: res([]) }], annotated: false }), /sin detecciones/);
});
