import { test } from "node:test";
import assert from "node:assert/strict";
import { LIMITS } from "@/lib/domain";
import {
  buildSplatManifest,
  callbackUrlFor,
  estimateFrameCount,
  isReconstructionEligible,
  selectReconstructionMedia,
} from "./manifest";
import { frame, INCIDENT_ID, media, REC_ID } from "./test-fixtures";

const videoPath = `incidents/${INCIDENT_ID}/media/m1/video.mp4`;

const citizen = media("m1", {
  label: "M1",
  video_path: videoPath,
  video_status: "uploaded",
  duration_s: 20,
  frames: [frame("m1", 1), frame("m1", 0)],
});
const drone = media("m2", {
  label: "M2",
  source: "drone",
  kind: "frames",
  lat: null,
  lng: null,
  accuracy_m: null,
  heading_deg: null,
  frames: [
    frame("m2", 0, { lat: -33.4501, lng: -70.6601, alt_m: 45, heading_deg: 10 }),
    frame("m2", 1, { lat: -33.4502, lng: -70.6602, alt_m: 46, heading_deg: 20 }),
  ],
});
const svgPosters = media("m4", {
  label: "M4",
  source: "drone",
  frames: [{ ...frame("m4", 0), storage_path: `incidents/${INCIDENT_ID}/media/m4/frames/000.svg` }],
});
const videoUploading = media("m5", { label: "M5", video_path: videoPath, video_status: "uploading" });

test("elegibilidad: excluye cuadros que no son JPEG y videos que no terminaron de subir", () => {
  assert.equal(isReconstructionEligible(citizen), true);
  assert.equal(isReconstructionEligible(drone), true);
  assert.equal(isReconstructionEligible(svgPosters), false);
  assert.equal(isReconstructionEligible(videoUploading), false);
});

test("selección: todos los elegibles o solo los pedidos", () => {
  const all = [citizen, drone, svgPosters, videoUploading];
  assert.deepEqual(selectReconstructionMedia(all).map((m) => m.id), ["m1", "m2"]);
  assert.deepEqual(selectReconstructionMedia(all, ["m2", "m4", "nope"]).map((m) => m.id), ["m2"]);
  assert.deepEqual(selectReconstructionMedia(all, []).map((m) => m.id), ["m1", "m2"]);
});

test("manifiesto: video original preferido, cuadros ordenados y posición por cuadro del dron", () => {
  const manifest = buildSplatManifest({
    incident: { id: INCIDENT_ID, lat: -33.45, lng: -70.66 },
    reconstructionId: REC_ID,
    media: [citizen, drone],
    bucket: "mi-bucket",
    callbackUrl: callbackUrlFor("https://vigia.example/", INCIDENT_ID),
    iterations: 7000,
  });
  assert.equal(manifest.version, 1);
  assert.equal(manifest.incident_id, INCIDENT_ID);
  assert.equal(manifest.reconstruction_id, REC_ID);
  assert.deepEqual(manifest.origin, { lat: -33.45, lng: -70.66 });
  assert.equal(manifest.bucket, "mi-bucket");
  assert.equal(manifest.output_prefix, `incidents/${INCIDENT_ID}/reconstructions/${REC_ID}/`);
  assert.equal(manifest.callback_url, `https://vigia.example/api/internal/reconstruction/${INCIDENT_ID}`);
  assert.equal(manifest.max_frames, LIMITS.SPLAT_MAX_FRAMES);
  assert.equal(manifest.sample_fps, LIMITS.SPLAT_SAMPLE_FPS);
  assert.equal(manifest.media.length, 2);

  const [m1, m2] = manifest.media;
  assert.equal(m1.source, "citizen");
  assert.equal(m1.video_path, videoPath);
  assert.equal(m1.lat, -33.45);
  assert.equal(m1.heading_deg, 120);
  assert.deepEqual(m1.frames.map((f) => f.t_s), [0, 0.5], "ordenados por índice");
  assert.equal(m1.frames[0].lat, null);

  assert.equal(m2.source, "drone");
  assert.equal(m2.video_path, null);
  assert.deepEqual(m2.frames[1], {
    path: `incidents/${INCIDENT_ID}/media/m2/frames/001.jpg`,
    t_s: 0.5,
    lat: -33.4502,
    lng: -70.6602,
    alt_m: 46,
    heading_deg: 20,
  });
  // Es JSON puro: sobrevive al viaje por el bucket sin cambios.
  assert.deepEqual(JSON.parse(JSON.stringify(manifest)), manifest);
});

test("estimación de cuadros: video a sample_fps, si no los cuadros; con tope", () => {
  const manifest = buildSplatManifest({
    incident: { id: INCIDENT_ID, lat: 0, lng: 0 },
    reconstructionId: REC_ID,
    media: [citizen, drone],
    bucket: "b",
    callbackUrl: "x",
    iterations: 7000,
  });
  // 20 s × 3 fps = 60 del video + 2 del dron.
  assert.equal(estimateFrameCount(manifest, { m1: 20, m2: null }), 62);
  assert.equal(estimateFrameCount(manifest, {}), 4, "sin duración cuentan los cuadros ya extraídos");
  assert.equal(estimateFrameCount(manifest, { m1: 1000 }), LIMITS.SPLAT_MAX_FRAMES);
});
