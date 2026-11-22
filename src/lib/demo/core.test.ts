/**
 * Siembra y simulacro de punta a punta contra el store local real (carpeta temporal),
 * con un pipeline falso que registra las llamadas.
 *   node --import tsx --test src/lib/demo/core.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vigia-demo-test-"));
process.env.VIGIA_DATA_DIR = dataDir;
delete process.env.DATABASE_URL;
delete process.env.GCS_BUCKET;

type Mod = {
  core: typeof import("./core");
  data: typeof import("./data-scenario");
  store: typeof import("@/lib/store/local");
  files: typeof import("@/lib/store/local-files");
  validate: typeof import("./validate");
};
let mod: Mod;

before(async () => {
  mod = {
    core: await import("./core"),
    data: await import("./data-scenario"),
    store: await import("@/lib/store/local"),
    files: await import("@/lib/store/local-files"),
    validate: await import("./validate"),
  };
});
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function makeDeps() {
  const calls: string[] = [];
  const deferred: (() => Promise<void>)[] = [];
  const deps = {
    store: mod.store.createLocalStore(),
    files: mod.files.createLocalFiles(),
    pipeline: {
      processMedia: async (id: string) => void calls.push(`media:${id}`),
      requestFusion: async (id: string) => void calls.push(`fusion:${id}`),
      requestCommsAnalysis: async (id: string) => void calls.push(`comms:${id}`),
    },
    now: Date.now,
    defer: (t: () => Promise<void>) => void deferred.push(t),
  };
  const flush = async () => {
    while (deferred.length) await deferred.shift()!();
  };
  return { deps, calls, flush };
}

test("las vitrinas validan sin problemas", () => {
  for (const s of mod.core.SHOWCASES) assert.deepEqual(mod.validate.validateShowcase(s), [], s.title);
  assert.deepEqual(mod.validate.validateScenario(mod.data.SCENARIO), []);
});

test("seedDemo siembra ambas vitrinas completas y es idempotente", async () => {
  const { deps } = makeDeps();
  const first = await mod.core.seedDemoWith(deps);
  const again = await mod.core.seedDemoWith(deps);
  assert.equal(again.incident_id, first.incident_id);

  const incidents = await deps.store.listIncidents();
  assert.equal(incidents.length, mod.core.SHOWCASES.length);
  for (const spec of mod.core.SHOWCASES) {
    const inc = incidents.find((i) => i.title === spec.title);
    assert.ok(inc, spec.title);
    assert.equal(inc.origin, "demo");
    assert.equal(inc.situation_engine, "simulated");
    assert.equal(inc.scene_engine, "simulated");
    assert.equal(inc.comms_engine, "simulated");
    assert.ok(inc.situation && inc.scene && inc.comms_analysis);

    const media = await deps.store.listMedia(inc.id);
    assert.equal(media.length, spec.media.length);
    media.forEach((m, i) => {
      assert.equal(m.label, `M${i + 1}`);
      assert.equal(m.status, "analyzed");
      assert.equal(m.analysis_engine, "simulated");
      assert.equal(m.frames.length, spec.media[i].frames.length);
      assert.ok(m.source === "demo" || (m.source === "drone" && m.mission_id));
    });
    for (const m of media)
      for (const f of m.frames) {
        assert.match(f.storage_path, /^incidents\/[0-9a-f-]+\/media\/[0-9a-f-]+\/frames\/\d{3}\.svg$/);
        assert.ok(await deps.files.exists(f.storage_path), f.storage_path);
        const { bytes } = await deps.files.download(f.storage_path);
        assert.match(new TextDecoder().decode(bytes), /IMAGEN DE DEMOSTRACIÓN/);
      }

    const comms = await deps.store.listComms(inc.id);
    assert.equal(comms.length, spec.comms.length);
    assert.ok(comms.every((c) => c.source === "simulated"));
    assert.ok(comms.every((c) => Date.parse(c.at) <= Date.now()));

    const missions = await deps.store.listMissions(inc.id);
    assert.equal(missions.length, spec.mission ? 1 : 0);
    if (spec.mission) {
      const m = missions[0];
      assert.equal(m.mode, "simulated");
      assert.equal(m.status, "on_station");
      assert.ok(m.track.length > 20, `traza de ${m.track.length} puntos`);
      assert.ok(m.last && m.last.alt_m > 30);
      const droneFrames = media.filter((x) => x.mission_id === m.id).reduce((n, x) => n + x.frames.length, 0);
      assert.equal(m.frames_received, droneFrames);
    }

    const events = await deps.store.listEvents(inc.id, 500);
    assert.ok(events.some((e) => e.kind === "incident_created"));
    assert.ok(events.every((e) => Date.parse(e.at) <= Date.now() + 1000));
    assert.equal(events.filter((e) => e.kind === "comms").length, spec.comms.length);
  }
});

test("una vitrina a medias se cierra y se vuelve a sembrar", async () => {
  const { deps } = makeDeps();
  const spec = mod.core.SHOWCASES[1];
  const prior = (await deps.store.listIncidents()).find((i) => i.title === spec.title)!;
  // Simula una siembra interrumpida: mismo título, sin informe.
  const broken = await deps.store.createIncident({
    type: spec.type,
    title: spec.title,
    address: spec.address,
    lat: spec.lat,
    lng: spec.lng,
    description: "",
    origin: "demo",
    verified: true,
  });
  await deps.store.updateIncident(prior.id, { title: "renombrada en la prueba" });
  await mod.core.seedDemoWith(deps);
  const closed = await deps.store.getIncident(broken.id);
  assert.equal(closed?.status, "closed");
  assert.match(closed?.title ?? "", /siembra incompleta/);
  const fresh = (await deps.store.listIncidents()).filter((i) => i.title === spec.title);
  assert.equal(fresh.length, 1);
  assert.ok(fresh[0].situation);
});

test("simulacro de punta a punta, con reintentos sin duplicar", async () => {
  const { deps, calls, flush } = makeDeps();
  const steps = mod.data.SCENARIO.steps;
  const start = await mod.core.runScenarioStepCore(deps, null, 0);
  const restart = await mod.core.runScenarioStepCore(deps, null, 0);
  assert.equal(restart.incident_id, start.incident_id, "un paso 0 repetido reutiliza el simulacro");
  assert.equal(start.total_steps, steps.length);
  const id = start.incident_id;

  for (let i = 1; i < steps.length; i++) {
    const r = await mod.core.runScenarioStepCore(deps, id, i);
    const retry = await mod.core.runScenarioStepCore(deps, id, i);
    assert.deepEqual(retry, r);
    assert.equal(r.label, steps[i].label);
    // Antes del lote del dron se espera (≤ 20 s) a que el dron simulado llegue a su órbita.
    const beforeDroneBatch = Boolean(steps[i + 1]?.drone_media);
    assert.ok(r.wait_s >= 3 && r.wait_s <= (beforeDroneBatch ? 20 : 8), `paso ${i}: espera ${r.wait_s} s`);
    if (beforeDroneBatch) assert.ok(r.wait_s > steps[i].wait_s, "el dron aún no despega: se le da tiempo");
    assert.equal(r.done, i === steps.length - 1);
    assert.equal(r.next_step, i + 1);
    await flush();
  }

  const comms = await deps.store.listComms(id);
  const expectedComms = steps.reduce((n, s) => n + (s.comms?.length ?? 0), 0);
  assert.equal(comms.length, expectedComms);
  const media = await deps.store.listMedia(id);
  const expectedMedia = steps.filter((s) => s.media).length + steps.filter((s) => s.drone_media).length;
  assert.equal(media.length, expectedMedia);
  assert.ok(media.every((m) => m.analysis && m.analysis_engine === "simulated"));
  assert.ok(media.every((m) => m.status === "uploaded"), "el pipeline falso no los procesa");
  const missions = await deps.store.listMissions(id);
  assert.equal(missions.length, 1);
  assert.equal(missions[0].mode, "simulated");
  // Despega desde el puesto de mando cercano, no a 300 m.
  const { distanceM } = await import("@/lib/geo");
  const drill = (await deps.store.getIncident(id))!;
  const homeM = distanceM({ lat: drill.lat, lng: drill.lng }, { lat: missions[0].home_lat, lng: missions[0].home_lng });
  assert.ok(homeM > 40 && homeM < 80, `despegue a ${homeM} m`);
  const drone = media.find((m) => m.source === "drone");
  assert.ok(drone && drone.mission_id === missions[0].id);
  assert.equal(missions[0].frames_received, drone.frames.length);

  // processMedia una vez por medio (los reintentos lo vuelven a pedir solo si sigue "uploaded").
  for (const m of media) assert.ok(calls.includes(`media:${m.id}`));
  assert.ok(calls.includes(`comms:${id}`));

  const inc = await deps.store.getIncident(id);
  const last = steps[steps.length - 1];
  if (last.status) assert.equal(inc?.status, last.status);
  const titles = (await deps.store.listEvents(id, 500)).map((e) => e.title);
  assert.equal(new Set(titles.filter((t) => !t.includes(":"))).size, titles.filter((t) => !t.includes(":")).length);
});

test("el simulacro rechaza pasos inválidos", async () => {
  const { deps } = makeDeps();
  await assert.rejects(mod.core.runScenarioStepCore(deps, null, 3), /paso 0/);
  await assert.rejects(mod.core.runScenarioStepCore(deps, null, 99), /fuera de rango/);
  await assert.rejects(mod.core.runScenarioStepCore(deps, "no-existe", 1), /no existe/);
  const real = await deps.store.createIncident({
    type: "structure_fire",
    title: "Incidente real",
    address: "",
    lat: -33.45,
    lng: -70.6,
    description: "",
    origin: "command",
    verified: true,
  });
  await assert.rejects(mod.core.runScenarioStepCore(deps, real.id, 1), /no es un simulacro/);
});
