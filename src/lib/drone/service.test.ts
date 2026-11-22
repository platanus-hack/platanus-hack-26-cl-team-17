/**
 * Servicio del dron contra el store local real (carpeta temporal).
 *   node --import tsx --test src/lib/drone/service.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { CreateMissionInputSchema, LIMITS } from "@/lib/domain";
import { sha256Hex } from "@/lib/ids";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vigia-drone-test-"));
process.env.VIGIA_DATA_DIR = dataDir;
delete process.env.DATABASE_URL;

type Svc = typeof import("./service");
let svc: Svc;
let deps: import("./service").DroneDeps;
let clock = Date.parse("2026-11-21T22:00:00.000Z");
const processed: string[] = [];
const deferred: (() => Promise<void>)[] = [];

before(async () => {
  svc = await import("./service");
  const { createLocalStore } = await import("@/lib/store/local");
  const { createLocalFiles } = await import("@/lib/store/local-files");
  deps = {
    store: createLocalStore(),
    files: createLocalFiles(),
    now: () => clock,
    defer: (t) => void deferred.push(t),
    processMedia: async (id) => void processed.push(id),
  };
});
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

async function newIncident() {
  return deps.store.createIncident({
    type: "structure_fire",
    title: "Prueba dron",
    address: "Calle de prueba 123",
    lat: -33.4569,
    lng: -70.5987,
    description: "",
    origin: "command",
    verified: true,
  });
}

/** JPEG mínimo válido en cabecera: SOI + SOF0 1280×720 + EOI. */
function fakeJpeg(width = 1280, height = 720): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]);
}

test("crear misión: token una vez, ruta del sensor, evento y tope de 2 activas", async () => {
  const inc = await newIncident();
  const input = CreateMissionInputSchema.parse({ mode: "device" });
  const res = await svc.createMission(deps, inc.id, input);
  assert.equal(res.mission.label, "D1");
  assert.equal(res.mission.status, "planned");
  assert.equal(res.sensor_path, `/dron/${res.mission.id}?t=${encodeURIComponent(res.ingest_token)}`);
  assert.ok(await deps.store.verifyIngestToken(res.mission.id, sha256Hex(res.ingest_token)));
  assert.equal(res.mission.waypoints.length, 16);
  const events = await deps.store.listEvents(inc.id);
  assert.ok(events.some((e) => e.title === "Dron D1 desplegado — órbita de 60 m a 45 m de altura"));
  await svc.createMission(deps, inc.id, CreateMissionInputSchema.parse({ mode: "api", pattern: "hover" }));
  await assert.rejects(
    svc.createMission(deps, inc.id, CreateMissionInputSchema.parse({ mode: "api" })),
    /misiones activas/,
  );
});

test("token inválido → 401 sin revelar si la misión existe", async () => {
  const inc = await newIncident();
  const res = await svc.createMission(deps, inc.id, CreateMissionInputSchema.parse({ mode: "api" }));
  await assert.rejects(svc.authorizeDrone(deps.store, res.mission.id, "malo"), /Token de dron inválido/);
  await assert.rejects(svc.authorizeDrone(deps.store, "no-existe", res.ingest_token), /Token de dron inválido/);
  await assert.rejects(svc.authorizeDrone(deps.store, res.mission.id, null), /Falta el token/);
  const ok = await svc.authorizeDrone(deps.store, res.mission.id, res.ingest_token);
  assert.equal(ok.id, res.mission.id);
});

test("telemetría: estados, orden pendiente y puntos sin futuro", async () => {
  const inc = await newIncident();
  const { mission } = await svc.createMission(deps, inc.id, CreateMissionInputSchema.parse({ mode: "device" }));
  const future = new Date(clock + 3_600_000).toISOString();
  let r = await svc.ingestTelemetry(deps, mission, {
    points: [{ at: future, lat: inc.lat, lng: inc.lng, alt_m: 2, heading_deg: 90 }],
  });
  assert.equal(r.status, "on_station");
  assert.equal(r.command, "continue");
  let m = (await deps.store.getMission(mission.id))!;
  assert.ok(m.started_at);
  assert.ok(Date.parse(m.last!.at) <= clock);

  await svc.commandMission(deps, mission.id, "recall");
  r = await svc.ingestTelemetry(deps, m, { points: [{ lat: inc.lat, lng: inc.lng, alt_m: 2, heading_deg: 90 }] });
  assert.equal(r.command, "recall");
  m = (await deps.store.getMission(mission.id))!;
  r = await svc.ingestTelemetry(deps, m, {
    points: [{ lat: inc.lat, lng: inc.lng, alt_m: 0, heading_deg: 90 }],
    status: "landed",
  });
  assert.equal(r.status, "landed");
  m = (await deps.store.getMission(mission.id))!;
  assert.ok(m.ended_at);
  // Terminada: no acepta más puntos.
  const before = m.track.length;
  await svc.ingestTelemetry(deps, m, { points: [{ lat: 0.1, lng: 0.1, alt_m: 0, heading_deg: 0 }] });
  assert.equal((await deps.store.getMission(mission.id))!.track.length, before);
  await assert.rejects(svc.commandMission(deps, mission.id, "abort"), /ya terminó/);
});

test("órdenes: abortar una misión que nunca despegó la cierra; reanudar retira el retorno", async () => {
  const inc = await newIncident();
  const a = await svc.createMission(deps, inc.id, CreateMissionInputSchema.parse({ mode: "api" }));
  const aborted = await svc.commandMission(deps, a.mission.id, "abort");
  assert.equal(aborted.status, "aborted");
  assert.ok(aborted.ended_at);
  const b = await svc.createMission(deps, inc.id, CreateMissionInputSchema.parse({ mode: "device" }));
  await svc.ingestTelemetry(deps, b.mission, {
    points: [{ lat: inc.lat, lng: inc.lng, alt_m: 20, heading_deg: 0 }],
    status: "launching",
  });
  const recalled = await svc.commandMission(deps, b.mission.id, "recall");
  assert.equal(recalled.command, "recall");
  const resumed = await svc.commandMission(deps, b.mission.id, "resume");
  assert.equal(resumed.command, "continue");
});


test("cuadros: lote de 6 → uploaded + processMedia; flush cierra antes; rechaza no-JPEG y tamaño", async () => {
  const inc = await newIncident();
  const { mission } = await svc.createMission(deps, inc.id, CreateMissionInputSchema.parse({ mode: "device" }));
  const params = (flush = false) => ({ lat: inc.lat, lng: inc.lng, alt: 40, heading: 10, t: null, flush });
  let last;
  for (let i = 0; i < LIMITS.DRONE_BATCH_FRAMES; i++) {
    const m = (await deps.store.getMission(mission.id))!;
    clock += 5_000;
    last = await svc.ingestFrame(deps, m, fakeJpeg(), params());
    assert.equal(last.frame_idx, i);
    assert.equal(last.flushed, i === LIMITS.DRONE_BATCH_FRAMES - 1);
  }
  const batch = (await deps.store.getMedia(last!.media_id))!;
  assert.equal(batch.label, "M1");
  assert.equal(batch.source, "drone");
  assert.equal(batch.status, "uploaded");
  assert.equal(batch.frames.length, LIMITS.DRONE_BATCH_FRAMES);
  assert.deepEqual([batch.frames[0].width, batch.frames[0].height], [1280, 720]);
  assert.equal(batch.frames[5].t_s, 25);
  assert.ok(await deps.files.exists(batch.frames[0].storage_path));
  while (deferred.length) await deferred.shift()!();
  assert.ok(processed.includes(batch.id));
  assert.equal((await deps.store.getMission(mission.id))!.frames_received, LIMITS.DRONE_BATCH_FRAMES);

  const m = (await deps.store.getMission(mission.id))!;
  const one = await svc.ingestFrame(deps, m, fakeJpeg(640, 480), params(true));
  assert.equal(one.flushed, true);
  assert.notEqual(one.media_id, batch.id);
  const small = (await deps.store.getMedia(one.media_id))!;
  assert.equal(small.label, "M2");
  assert.deepEqual([small.frames[0].width, small.frames[0].height], [640, 480]);
  const titles = (await deps.store.listEvents(inc.id, 500)).map((e) => e.title);
  assert.ok(titles.includes("Lote de dron D1 — M1, 6 cuadros"));
  assert.ok(titles.includes("Lote de dron D1 — M2, 1 cuadro"));

  await assert.rejects(svc.ingestFrame(deps, m, new TextEncoder().encode("<svg/>"), params()), /JPEG/);
  await assert.rejects(svc.ingestFrame(deps, m, new Uint8Array(0), params()), /vacío/);
  const big = new Uint8Array(LIMITS.MAX_FRAME_BYTES + 1);
  big.set([0xff, 0xd8, 0xff]);
  await assert.rejects(svc.ingestFrame(deps, m, big, params()), /3 MB/);
});

test("parseFrameParams: valores fuera de rango se ignoran; t acepta ISO, segundos o ms", () => {
  const p = svc.parseFrameParams(new URL("http://x/f?lat=-33.4&lng=999&alt=40&heading=361&t=1763762400&flush=1"));
  assert.equal(p.lat, -33.4);
  assert.equal(p.lng, null);
  assert.equal(p.alt, 40);
  assert.equal(p.heading, null);
  assert.equal(p.t, new Date(1763762400 * 1000).toISOString());
  assert.equal(p.flush, true);
  assert.equal(svc.parseFrameParams(new URL("http://x/f?t=1763762400000")).t, new Date(1763762400000).toISOString());
  assert.equal(svc.parseFrameParams(new URL("http://x/f?t=2026-11-21T22:00:00Z")).t, "2026-11-21T22:00:00.000Z");
  assert.equal(svc.parseFrameParams(new URL("http://x/f")).flush, false);
});

test("readLimitedBody corta al pasar el tope", async () => {
  const req = new Request("http://x", { method: "POST", body: new Uint8Array(10) });
  assert.equal((await svc.readLimitedBody(req, 10)).byteLength, 10);
  const req2 = new Request("http://x", { method: "POST", body: new Uint8Array(11) });
  await assert.rejects(svc.readLimitedBody(req2, 10), /3 MB/);
});
