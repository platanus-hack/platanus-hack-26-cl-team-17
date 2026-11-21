/**
 * Guardado y lectura de MediaDetections contra el storage local real (carpeta temporal).
 *   node --import tsx --test src/lib/vision/media-detections.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { FileStorage } from "@/lib/store/types";
import type { DetectResult } from "./types";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vigia-detections-test-"));
process.env.VIGIA_DATA_DIR = dataDir;
delete process.env.GCS_BUCKET;

type Mod = typeof import("./media-detections");
let mod: Mod;
let files: FileStorage;

before(async () => {
  mod = await import("./media-detections");
  const { createLocalFiles } = await import("@/lib/store/local-files");
  files = createLocalFiles();
});
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const r = (labels: [string, number][]): DetectResult => {
  const detections = labels.map(([label, conf]) => ({
    label,
    conf,
    box: [0.1, 0.2, 0.3, 0.4] as [number, number, number, number],
    zone: { h: "centro" as const, v: "medio" as const },
    pose: null,
  }));
  const counts: Record<string, number> = {};
  for (const d of detections) counts[d.label] = (counts[d.label] ?? 0) + 1;
  return { width: 1280, height: 720, ms: 91, detections, counts };
};

test("rutas: junto a los fotogramas del medio", () => {
  assert.equal(mod.mediaDetectionsPath("inc-1", "med-2"), "incidents/inc-1/media/med-2/detections.json");
  assert.equal(mod.mediaAnnotatedPath("inc-1", "med-2"), "incidents/inc-1/media/med-2/annotated.jpg");
});

test("guarda y lee MediaDetections; sin archivo → null", async () => {
  const incidentId = "11111111-2222-3333-4444-555555555555";
  assert.equal(await mod.loadMediaDetections(files, incidentId, "m1"), null);

  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 0xff, 0xd9]);
  const keyPath = await mod.saveAnnotatedFrame(files, incidentId, "m1", jpeg);
  assert.equal(keyPath, mod.mediaAnnotatedPath(incidentId, "m1"));
  const frames = [
    { idx: 3, t_s: 6, result: mod.withoutAnnotation({ ...r([["persona", 0.9], ["persona", 0.7]]), annotated_jpeg_b64: "xx" }) },
    { idx: 0, t_s: 0, result: r([["humo", 0.2]]) },
  ];
  await mod.saveMediaDetections(files, incidentId, {
    media_id: "m1",
    media_label: "M1",
    at: "2026-11-21T00:20:00.000Z",
    model: "yoloe-26s-seg",
    frames,
    keyframe: { idx: 3, path: keyPath },
    aggregate: [],
  });

  const got = await mod.loadMediaDetections(files, incidentId, "m1");
  assert.ok(got);
  assert.equal(got.media_label, "M1");
  assert.equal(got.model, "yoloe-26s-seg");
  assert.deepEqual(got.frames.map((f) => f.idx), [0, 3], "en orden de idx");
  assert.ok(!("annotated_jpeg_b64" in got.frames[1].result));
  assert.deepEqual(got.keyframe, { idx: 3, path: keyPath });
  // El resumen se recalcula al leer.
  assert.deepEqual(
    got.aggregate.map((a) => [a.label, a.max_count, a.frames]),
    [
      ["persona", 2, 1],
      ["humo", 1, 1],
    ],
  );
  const img = await files.download(keyPath);
  assert.deepEqual([...img.bytes], [...jpeg]);
});

test("un archivo corrupto o ajeno se lee como null, nunca lanza", async () => {
  const incidentId = "11111111-2222-3333-4444-666666666666";
  await files.upload(mod.mediaDetectionsPath(incidentId, "m9"), new TextEncoder().encode("{no es json"), "application/json");
  assert.equal(await mod.loadMediaDetections(files, incidentId, "m9"), null);
  assert.equal(mod.parseMediaDetections({ media_id: 1 }), null);
  const parsed = mod.parseMediaDetections({
    media_id: "m",
    media_label: "M2",
    frames: [{ idx: -1, result: r([]) }, { idx: 1, t_s: "x", result: { nope: true } }, { idx: 2, result: r([["auto", 0.5]]) }],
    keyframe: { idx: 2, path: "/etc/passwd" },
  });
  assert.ok(parsed);
  assert.deepEqual(parsed.frames.map((f) => f.idx), [2]);
  assert.equal(parsed.keyframe, null, "solo rutas dentro de incidents/");
  assert.equal(parsed.model, null);
});
