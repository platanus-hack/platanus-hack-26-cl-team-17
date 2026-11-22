/**
 * Video en vivo del dron contra el store local real (carpeta temporal), con un doble del observador (sin credencial de IA).
 *   node --import tsx --test src/lib/drone/live.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vigia-live-test-"));
process.env.VIGIA_DATA_DIR = dataDir;
delete process.env.DATABASE_URL;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

type Live = typeof import("./live");
let live: Live;
let deps: import("./service").DroneDeps;
let clock = Date.parse("2026-11-21T22:00:00.000Z");
const deferred: (() => Promise<void>)[] = [];

before(async () => {
  live = await import("./live");
  const { createLocalStore } = await import("@/lib/store/local");
  const { createLocalFiles } = await import("@/lib/store/local-files");
  deps = {
    store: createLocalStore(),
    files: createLocalFiles(),
    now: () => clock,
    defer: (t) => void deferred.push(t),
    processMedia: async () => undefined,
    // Doble del observador (sin IA real): resume cuántos cuadros recibió.
    analyzeLive: async (input) => ({
      summary: `${input.frames.length} ${input.frames.length === 1 ? "cuadro" : "cuadros"} del dron ${input.mission.label}`,
      severity: "info",
      changed: false,
      observations: [],
      engine: "claude",
    }),
  };
});
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

async function runDeferred() {
  while (deferred.length) await deferred.shift()!();
}

async function newMission() {
  const incident = await deps.store.createIncident({
    type: "structure_fire",
    title: "Prueba video en vivo",
    address: "Calle de prueba 123",
    lat: -33.4569,
    lng: -70.5987,
    description: "",
    origin: "command",
    verified: true,
  });
  const { createMission } = await import("./service");
  const { CreateMissionInputSchema } = await import("@/lib/domain");
  const res = await createMission(deps, incident.id, CreateMissionInputSchema.parse({ mode: "device" }));
  return res.mission;
}

const jpeg = (n: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, n & 0xff, 0x00, 0xff, 0xd9]);

test("pickWindowFrames: hasta 3 cuadros repartidos en la ventana, siempre con el último", () => {
  const frames = Array.from({ length: 45 }, (_, i) => ({ at: i * 333 }));
  const now = 44 * 333;
  const picked = live.pickWindowFrames(frames, now, 15_000, 3);
  assert.equal(picked.length, 3);
  assert.equal(picked.at(-1), frames.at(-1));
  assert.ok(picked[0].at < picked[1].at && picked[1].at < picked[2].at);
  assert.deepEqual(live.pickWindowFrames(frames.slice(0, 2), 333, 15_000, 3), frames.slice(0, 2));
  assert.deepEqual(live.pickWindowFrames(frames, now + 60_000, 15_000, 3), []);
});

test("cuadros en vivo: el último se sirve, 'unchanged' sin novedad y una observación por ventana", async () => {
  const mission = await newMission();
  assert.equal(await live.getLiveFrame(deps, mission.id, null), null);

  const first = await live.pushLiveFrame(deps, mission, jpeg(1));
  clock += 333;
  const second = await live.pushLiveFrame(deps, mission, jpeg(2));
  assert.ok(second.seq > first.seq);

  const got = await live.getLiveFrame(deps, mission.id, null);
  assert.ok(got && got !== "unchanged");
  assert.equal(got.seq, second.seq);
  assert.equal(got.bytes[4], 2);
  assert.equal(await live.getLiveFrame(deps, mission.id, second.seq), "unchanged");

  // La primera observación espera unos segundos de video; después, una cada 15 s.
  await runDeferred();
  assert.equal(live.listLiveInsights(mission.id).insights.length, 0);
  clock += 3000;
  await live.pushLiveFrame(deps, mission, jpeg(3));
  await runDeferred();
  let { insights } = live.listLiveInsights(mission.id);
  assert.equal(insights.length, 1);
  assert.equal(insights[0].engine, "claude");

  clock += 5000;
  await live.pushLiveFrame(deps, mission, jpeg(4));
  await runDeferred();
  assert.equal(live.listLiveInsights(mission.id).insights.length, 1, "antes de 15 s no hay otra observación");

  clock += 10_500;
  await live.pushLiveFrame(deps, mission, jpeg(5));
  await runDeferred();
  ({ insights } = live.listLiveInsights(mission.id));
  assert.equal(insights.length, 2);
  assert.equal(insights[0].frames, 2, "solo los cuadros de los últimos 15 s");
});

test("cuadros en vivo: rechaza lo que no es JPEG y misiones terminadas", async () => {
  const mission = await newMission();
  await assert.rejects(live.pushLiveFrame(deps, mission, new Uint8Array([1, 2, 3])), /JPEG/);
  await assert.rejects(live.pushLiveFrame(deps, { ...mission, status: "landed" }, jpeg(1)), /terminó/);
});

test("otra instancia: sin memoria sirve la copia del storage", async () => {
  const mission = await newMission();
  const { storagePaths } = await import("@/lib/store/types");
  await deps.files.upload(storagePaths.live(mission.incident_id, mission.id), jpeg(9), "image/jpeg");
  const got = await live.getLiveFrame(deps, mission.id, null);
  assert.ok(got && got !== "unchanged");
  assert.equal(got.source, "storage");
  assert.equal(got.bytes[4], 9);
});
