import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CreateReportInput } from "@/lib/domain";
import type { FileStorage, Store } from "@/lib/store/types";

const dir = mkdtempSync(path.join(os.tmpdir(), "vigia-reports-"));
process.env.VIGIA_DATA_DIR = dir;
delete process.env.DATABASE_URL;
delete process.env.GCS_BUCKET;

type Reports = typeof import("@/lib/server/reports");
let R: Reports;
let S: {
  getStore: () => Store;
  getFiles: () => FileStorage;
  storagePaths: typeof import("@/lib/store/types").storagePaths;
};
let D: { store: Store; files: FileStorage };

before(async () => {
  R = await import("@/lib/server/reports");
  const { createLocalStore } = await import("@/lib/store/local");
  const { createLocalFiles } = await import("@/lib/store/local-files");
  const { storagePaths } = await import("@/lib/store/types");
  D = { store: createLocalStore(), files: createLocalFiles() };
  S = { getStore: () => D.store, getFiles: () => D.files, storagePaths };
});
after(() => rmSync(dir, { recursive: true, force: true }));

const HOME = { lat: -33.4489, lng: -70.6693 };
let n = 0;
/** Coordenadas separadas ~5 km por prueba para no cruzar incidentes. */
const spot = () => ({ lat: HOME.lat + 0.05 * ++n, lng: HOME.lng });

function input(over: Partial<CreateReportInput> = {}): CreateReportInput {
  return {
    kind: "video",
    mime: "video/mp4",
    size_bytes: 1000,
    duration_s: 12,
    lat: null,
    lng: null,
    accuracy_m: null,
    heading_deg: null,
    captured_at: null,
    note: "",
    frames: [
      { idx: 0, t_s: 1, width: 1280, height: 720 },
      { idx: 1, t_s: 4, width: 1280, height: 720 },
    ],
    upload_video: true,
    ...over,
  };
}

async function newIncident(at: { lat: number; lng: number }, status?: "active" | "controlled" | "closed") {
  return S.getStore().createIncident({
    type: "structure_fire",
    title: "Incendio",
    address: "Calle 1",
    lat: at.lat,
    lng: at.lng,
    description: "",
    origin: "command",
    verified: true,
    status,
  });
}

test("con código se adjunta a ese incidente", async () => {
  const inc = await newIncident(spot());
  const code = inc.code.toLowerCase().replace("-", " ");
  const res = await R.createReport(input({ incident_code: code }), { staff: null, ...D });
  assert.equal(res.incident_code, inc.code);
  assert.equal(res.created_incident, false);
  assert.equal(res.frame_uploads.length, 2);
  assert.ok(res.video_upload);
  assert.ok(res.upload_token.length > 10);
  const media = await S.getStore().getMedia(res.media_id);
  assert.equal(media?.source, "citizen");
  assert.equal(media?.status, "uploading");
  assert.equal(media?.video_status, "uploading");
  assert.equal(media?.frames.length, 2);
});

test("código inexistente → 404; incidente cerrado → 409", async () => {
  await assert.rejects(R.createReport(input({ incident_code: "VG-ZZZZ" }), { staff: null, ...D }), {
    status: 404,
  });
  const closed = await newIncident(spot(), "closed");
  await assert.rejects(R.findOpenIncidentByCode(closed.code, D), {
    status: 409,
    message: "Esta emergencia ya fue cerrada",
  });
});

test("sin código se une al incidente en terreno más cercano dentro del radio", async () => {
  const at = spot();
  const near = await newIncident({ lat: at.lat + 0.001, lng: at.lng }); // ~110 m
  await newIncident({ lat: at.lat + 0.0015, lng: at.lng }); // ~165 m, más lejos
  const res = await R.createReport(input({ ...at }), { staff: null, ...D });
  assert.equal(res.incident_code, near.code);
  assert.equal(res.created_incident, false);
});

test("sin código ni incidente cercano crea uno sin verificar", async () => {
  const at = spot();
  await newIncident({ lat: at.lat + 0.01, lng: at.lng }); // ~1,1 km: fuera del radio de unión
  const res = await R.createReport(input({ ...at, type_hint: "vehicle_fire" }), { staff: null, ...D });
  assert.equal(res.created_incident, true);
  const inc = await S.getStore().getIncidentByCode(res.incident_code);
  assert.ok(inc);
  assert.equal(inc.origin, "citizen");
  assert.equal(inc.verified, false);
  assert.equal(inc.type, "vehicle_fire");
  assert.match(inc.title, /^Reporte ciudadano — /);
  const events = await S.getStore().listEvents(inc.id);
  assert.ok(events.some((e) => e.kind === "incident_created" && e.severity === "warning"));
  assert.ok(events.some((e) => e.kind === "media_received" && /Nuevo video de vecino — M1/.test(e.title)));
});

test("sin ubicación ni código → 400 con mensaje claro", async () => {
  await assert.rejects(R.createReport(input(), { staff: null, ...D }), {
    status: 400,
    message: "Necesitamos tu ubicación o el código de la emergencia",
  });
});

test("validación de tipo, tamaño y contenido", () => {
  assert.throws(() => R.validateReportInput(input({ mime: "image/jpeg" })), { status: 400 });
  assert.throws(() => R.validateReportInput(input({ size_bytes: 300 * 1024 * 1024 })), { status: 413 });
  assert.throws(() => R.validateReportInput(input({ frames: [], upload_video: false })), { status: 400 });
  assert.throws(
    () => R.validateReportInput(input({ kind: "photo", mime: "image/jpeg", upload_video: true })),
    { status: 400 },
  );
  assert.equal(R.videoExtForMime("video/quicktime"), "mov");
  assert.equal(R.videoExtForMime("video/webm;codecs=vp9"), "webm");
  assert.equal(R.videoExtForMime("video/3gpp"), "3gp");
  assert.equal(R.videoExtForMime("video/mp4"), "mp4");
});

test("as_responder solo vale con sesión de personal", async () => {
  const inc = await newIncident(spot());
  const staff = { id: "demo", email: "demo@vigia.local", name: "Demo", role: "admin" as const, demo: true };
  const a = await R.createReport(input({ incident_code: inc.code, as_responder: true }), { staff: null, ...D });
  const b = await R.createReport(input({ incident_code: inc.code, as_responder: true }), { staff, ...D });
  assert.equal((await S.getStore().getMedia(a.media_id))?.source, "citizen");
  assert.equal((await S.getStore().getMedia(b.media_id))?.source, "responder");
});

test("complete: token, fotogramas, video e idempotencia", async () => {
  const inc = await newIncident(spot());
  const res = await R.createReport(input({ incident_code: inc.code }), { staff: null, ...D });
  const store = S.getStore();
  const files = S.getFiles();
  const media = await store.getMedia(res.media_id);
  assert.ok(media);

  await assert.rejects(R.completeReport(res.media_id, "malo", { part: "frames", ok: true }, D), { status: 401 });
  await assert.rejects(R.completeReport(res.media_id, null, { part: "frames", ok: true }, D), { status: 401 });
  // Ningún fotograma subido todavía.
  await assert.rejects(R.completeReport(res.media_id, res.upload_token, { part: "frames", ok: true }, D), {
    status: 400,
  });

  for (const f of media.frames) await files.upload(f.storage_path, new Uint8Array([0xff, 0xd8]), "image/jpeg");
  const c1 = await R.completeReport(res.media_id, res.upload_token, { part: "frames", ok: true }, D);
  assert.deepEqual(c1, { process: true });
  assert.equal((await store.getMedia(res.media_id))?.status, "uploaded");
  const c2 = await R.completeReport(res.media_id, res.upload_token, { part: "frames", ok: true }, D);
  assert.deepEqual(c2, { process: false });

  await assert.rejects(R.completeReport(res.media_id, res.upload_token, { part: "video", ok: true }, D), {
    status: 400,
  });
  await files.upload(S.storagePaths.video(inc.id, res.media_id, "mp4"), new Uint8Array([1]), "video/mp4");
  const v1 = await R.completeReport(res.media_id, res.upload_token, { part: "video", ok: true }, D);
  assert.deepEqual(v1, { process: false }); // ya se analizó con fotogramas
  const after1 = await store.getMedia(res.media_id);
  assert.equal(after1?.video_status, "uploaded");
  assert.match(after1?.video_path ?? "", /video\.mp4$/);
  const v2 = await R.completeReport(res.media_id, res.upload_token, { part: "video", ok: false, error: "x" }, D);
  assert.deepEqual(v2, { process: false });
  assert.equal((await store.getMedia(res.media_id))?.video_status, "uploaded");
});

test("complete: sin fotogramas del navegador se analiza al llegar el video", async () => {
  const inc = await newIncident(spot());
  const res = await R.createReport(input({ incident_code: inc.code, frames: [] }), { staff: null, ...D });
  assert.equal(res.frame_uploads.length, 0);
  assert.deepEqual(await R.completeReport(res.media_id, res.upload_token, { part: "frames", ok: false }, D), {
    process: false,
  });
  await S.getFiles().upload(S.storagePaths.video(inc.id, res.media_id, "mp4"), new Uint8Array([1]), "video/mp4");
  assert.deepEqual(await R.completeReport(res.media_id, res.upload_token, { part: "video", ok: true }, D), {
    process: true,
  });
  assert.equal((await S.getStore().getMedia(res.media_id))?.status, "uploaded");
});

test("complete: video fallido sin fotogramas deja el medio en error", async () => {
  const inc = await newIncident(spot());
  const res = await R.createReport(input({ incident_code: inc.code, frames: [] }), { staff: null, ...D });
  await R.completeReport(res.media_id, res.upload_token, { part: "video", ok: false, error: "Se cortó" }, D);
  const m = await S.getStore().getMedia(res.media_id);
  assert.equal(m?.video_status, "failed");
  assert.equal(m?.status, "failed");
  assert.equal(m?.error, "Se cortó");
});

test("listNearbyPublic: solo activos dentro de 3 km, cercanos primero, coordenadas redondeadas", async () => {
  const at = spot();
  const a = await newIncident({ lat: at.lat + 0.01, lng: at.lng }); // ~1,1 km
  const b = await newIncident({ lat: at.lat + 0.002, lng: at.lng }); // ~220 m
  await newIncident({ lat: at.lat + 0.04, lng: at.lng }); // ~4,4 km
  await newIncident({ lat: at.lat + 0.001, lng: at.lng }, "closed");
  const list = await R.listNearbyPublic(at.lat, at.lng, D);
  assert.deepEqual(
    list.map((x) => x.code),
    [b.code, a.code],
  );
  assert.ok(list[0].distance_m !== null && list[0].distance_m < 300);
  assert.equal(list[0].lat, Math.round(b.lat * 1000) / 1000);
  assert.deepEqual(await R.listNearbyPublic(null, null, D), []);
});
