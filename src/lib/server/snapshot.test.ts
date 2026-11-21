import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncidentSnapshot, IncidentSummary, RuntimeMode, UnchangedResponse } from "@/lib/contract";
import type { Incident } from "@/lib/domain";
import type { Store } from "@/lib/store/types";
import { analysis, media, situation } from "./fixtures.test-helpers";

const dir = mkdtempSync(path.join(os.tmpdir(), "vigia-snapshot-"));
process.env.VIGIA_DATA_DIR = dir;
delete process.env.DATABASE_URL;
delete process.env.GCS_BUCKET;

type Snapshot = typeof import("./snapshot");
let S: Snapshot;
let store: Store;

before(async () => {
  S = await import("./snapshot");
  const { createLocalStore } = await import("@/lib/store/local");
  store = createLocalStore();
});
after(() => rmSync(dir, { recursive: true, force: true }));

const MODE: RuntimeMode = { store: "local", files: "local", ai: "simulated", auth: "open", model: null };
const BY = { name: "Oficial Pérez", demo: false };
const NOW = new Date("2026-11-21T15:00:00.000Z");

function isUnchanged(r: IncidentSnapshot | UnchangedResponse): r is UnchangedResponse {
  return r.unchanged === true;
}

async function newIncident(over: Partial<Parameters<Snapshot["createCommandIncident"]>[1]> = {}): Promise<Incident> {
  return S.createCommandIncident(
    store,
    { type: "structure_fire", address: "Av. Matta 1234", lat: -33.45, lng: -70.64, description: "", ...over },
    BY,
  );
}

describe("fileUrl / toMediaView", () => {
  test("URL estable de /api/files, con ?k= solo si se pide", () => {
    assert.equal(S.fileUrl("incidents/a/media/b/frames/000.jpg"), "/api/files/incidents/a/media/b/frames/000.jpg");
    assert.equal(
      S.fileUrl("incidents/a/media/b/frames/000.jpg", "k e/y"),
      "/api/files/incidents/a/media/b/frames/000.jpg?k=k%20e%2Fy",
    );
  });

  test("póster = primer fotograma clave del análisis; si no, el primer fotograma", () => {
    const withKey = S.toMediaView(media({ id: "m1", label: "M1", analysis: analysis([{ frame: 2, caption: "x" }]) }));
    assert.match(withKey.urls.poster ?? "", /frames\/002\.jpg$/);
    const plain = S.toMediaView(media({ id: "m2", label: "M2" }));
    assert.match(plain.urls.poster ?? "", /frames\/000\.jpg$/);
    const none = S.toMediaView(media({ id: "m3", label: "M3", frameCount: 0 }));
    assert.equal(none.urls.poster, null);
    assert.deepEqual(none.urls.frames, []);
  });

  test("fotogramas ordenados por idx; video solo si terminó de subir", () => {
    const m = media({ id: "m1", label: "M1", video_path: "incidents/i/media/m1/video.mp4", video_status: "uploading" });
    m.frames.reverse();
    const v = S.toMediaView(m);
    assert.deepEqual(v.urls.frames.map((f) => f.idx), [0, 1, 2]);
    assert.deepEqual(v.frames.map((f) => f.idx), [0, 1, 2]);
    assert.equal(v.urls.video, null);
    const up = S.toMediaView({ ...m, video_status: "uploaded" }, "KEY");
    assert.equal(up.urls.video, "/api/files/incidents/i/media/m1/video.mp4?k=KEY");
    assert.ok(up.urls.frames.every((f) => f.url.endsWith("?k=KEY")));
  });
});

describe("resumen y orden de la lista", () => {
  test("headline, gravedad y atrapados salen del informe; sin informe quedan null", async () => {
    const inc = await newIncident();
    const empty = S.toSummary(inc);
    assert.equal(empty.headline, null);
    assert.equal(empty.severity, null);
    assert.equal(empty.trapped_status, null);
    assert.equal(empty.media_count, 0);
    const withSit = S.toSummary(
      { ...inc, situation: situation({ headline: " Fuego en 2º piso ", severity: "critical", trapped: { status: "probable" } }) },
      { media: 3, comms: 2, active_missions: 1 },
    );
    assert.equal(withSit.headline, "Fuego en 2º piso");
    assert.equal(withSit.severity, "critical");
    assert.equal(withSit.trapped_status, "probable");
    assert.deepEqual([withSit.media_count, withSit.comms_count, withSit.active_missions], [3, 2, 1]);
    assert.equal("share_key" in withSit, false);
  });

  test("activos primero, luego controlados y cerrados; dentro, los más nuevos arriba", () => {
    const base = S.toSummary({
      id: "x",
      code: "VG-X",
      type: "other",
      title: "",
      address: "",
      lat: 0,
      lng: 0,
      status: "active",
      description: "",
      origin: "command",
      verified: true,
      share_key: "k",
      rev: 1,
      situation: null,
      situation_engine: null,
      situation_updated_at: null,
      scene: null,
      scene_engine: null,
      scene_updated_at: null,
      comms_analysis: null,
      comms_engine: null,
      comms_analysis_updated_at: null,
      pipeline: {
        fusion_status: "idle",
        fusion_error: null,
        fusion_requested_at: null,
        fusion_started_at: null,
        fusion_finished_at: null,
        comms_status: "idle",
        comms_error: null,
        comms_requested_at: null,
        comms_finished_at: null,
      },
      created_at: "2026-11-21T10:00:00.000Z",
      updated_at: "2026-11-21T10:00:00.000Z",
    });
    const mk = (id: string, status: IncidentSummary["status"], hour: number): IncidentSummary => ({
      ...base,
      id,
      code: `VG-${id}`,
      status,
      created_at: `2026-11-21T${String(hour).padStart(2, "0")}:00:00.000Z`,
    });
    const sorted = S.sortSummaries([
      mk("closedNew", "closed", 14),
      mk("activeOld", "active", 8),
      mk("controlled", "controlled", 13),
      mk("activeNew", "active", 12),
    ]);
    assert.deepEqual(sorted.map((s) => s.id), ["activeNew", "activeOld", "controlled", "closedNew"]);
  });

  test("listIncidentSummaries trae los conteos del store", async () => {
    const inc = await newIncident({ address: "Conteos 1" });
    await store.createMedia({ incident_id: inc.id, source: "citizen", kind: "photo" });
    await store.addComm({ incident_id: inc.id, text: "B-3 en el lugar", speaker: "B-3", channel: "", source: "manual" });
    const list = await S.listIncidentSummaries(store);
    const row = list.find((s) => s.id === inc.id);
    assert.ok(row);
    assert.equal(row.media_count, 1);
    assert.equal(row.comms_count, 1);
    assert.equal(row.active_missions, 0);
  });
});

describe("parseRev / sharePaths", () => {
  test("solo enteros ≥ 0", () => {
    assert.equal(S.parseRev("12"), 12);
    assert.equal(S.parseRev("0"), 0);
    for (const bad of [null, undefined, "", " ", "-1", "1.5", "abc", "1e400"]) assert.equal(S.parseRev(bad), null);
  });

  test("rutas para vecinos y para el carro", () => {
    const p = S.sharePaths({ id: "abc", code: "VG-7K3Q", share_key: "s3cr3t" });
    assert.deepEqual(p, { report_path: "/reportar/VG-7K3Q", briefing_path: "/en-ruta/abc?k=s3cr3t" });
  });
});

describe("loadIncidentSnapshot", () => {
  test("con el rev actual responde sin cambios; con otro, el snapshot completo", async () => {
    const inc = await newIncident({ address: "Rev 1" });
    const full = await S.loadIncidentSnapshot(store, inc.id, { rev: null, mode: MODE, now: NOW });
    assert.ok(!isUnchanged(full));
    assert.equal(full.incident.id, inc.id);
    assert.equal(full.server_time, NOW.toISOString());
    assert.deepEqual(full.mode, MODE);
    assert.equal(full.share.report_path, `/reportar/${inc.code}`);

    const same = await S.loadIncidentSnapshot(store, inc.id, { rev: full.incident.rev, mode: MODE, now: NOW });
    assert.deepEqual(same, { unchanged: true, rev: full.incident.rev, server_time: NOW.toISOString() });

    await store.addComm({ incident_id: inc.id, text: "Nueva", speaker: "", channel: "", source: "manual" });
    const next = await S.loadIncidentSnapshot(store, inc.id, { rev: full.incident.rev, mode: MODE, now: NOW });
    assert.ok(!isUnchanged(next));
    assert.equal(next.comms.length, 1);
    assert.ok(next.incident.rev > full.incident.rev);
  });

  test("404 si no existe (con y sin rev)", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    await assert.rejects(S.loadIncidentSnapshot(store, id, { rev: null, mode: MODE }), { status: 404 });
    await assert.rejects(S.loadIncidentSnapshot(store, id, { rev: 3, mode: MODE }), { status: 404 });
  });

  test("eventos: los 200 más recientes, primero el último", async () => {
    const inc = await newIncident({ address: "Eventos" });
    for (let i = 0; i < 205; i++) {
      await store.addEvent({
        incident_id: inc.id,
        kind: "alert",
        severity: "info",
        title: `E${i}`,
        detail: "",
        at: new Date(Date.UTC(2020, 0, 1, 12, 0, i)).toISOString(),
      });
    }
    const snap = await S.loadIncidentSnapshot(store, inc.id, { rev: null, mode: MODE });
    assert.ok(!isUnchanged(snap));
    assert.equal(snap.events.length, S.MAX_SNAPSHOT_EVENTS);
    // incident_created (ahora) es el más reciente; luego E204, E203…
    assert.equal(snap.events[0].kind, "incident_created");
    assert.equal(snap.events[1].title, "E204");
    for (let i = 1; i < snap.events.length; i++) {
      assert.ok(Date.parse(snap.events[i - 1].at) >= Date.parse(snap.events[i].at));
    }
  });

  test("los medios llevan URLs de /api/files sin clave", async () => {
    const inc = await newIncident({ address: "Medios" });
    const m = await store.createMedia({ incident_id: inc.id, source: "citizen", kind: "photo" });
    await store.addFrames(m.id, [
      { idx: 0, t_s: 0, width: 10, height: 10, storage_path: `incidents/${inc.id}/media/${m.id}/frames/000.jpg`, lat: null, lng: null, alt_m: null, heading_deg: null },
    ]);
    const snap = await S.loadIncidentSnapshot(store, inc.id, { rev: null, mode: MODE });
    assert.ok(!isUnchanged(snap));
    assert.equal(snap.media[0].urls.poster, `/api/files/incidents/${inc.id}/media/${m.id}/frames/000.jpg`);
  });
});

describe("crear y editar desde la central", () => {
  test("título por defecto con el tipo y la dirección", () => {
    assert.equal(S.defaultIncidentTitle("structure_fire", " Av. Matta 1234 "), "Incendio estructural — Av. Matta 1234");
    assert.equal(S.defaultIncidentTitle("vehicle_collision", ""), "Accidente de tránsito");
    assert.ok(S.defaultIncidentTitle("rescue", "x".repeat(300)).length <= 140);
  });

  test("createCommandIncident: origen central, verificado, evento y rev al día", async () => {
    const inc = await newIncident({ title: "  ", address: "Av. Grecia 100" });
    assert.equal(inc.origin, "command");
    assert.equal(inc.verified, true);
    assert.equal(inc.title, "Incendio estructural — Av. Grecia 100");
    const events = await store.listEvents(inc.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "incident_created");
    assert.match(events[0].title, new RegExp(inc.code));
    assert.match(events[0].detail, /Por Oficial Pérez/);
    assert.equal((await store.getIncidentRev(inc.id)), inc.rev);
    const custom = await newIncident({ title: "Fuego en bodega" });
    assert.equal(custom.title, "Fuego en bodega");
  });

  test("planIncidentUpdate: null si no cambia nada; cambios legibles", async () => {
    const inc = await newIncident({ address: "Plan" });
    assert.equal(S.planIncidentUpdate(inc, {}), null);
    assert.equal(S.planIncidentUpdate(inc, { status: "active", title: inc.title, lat: inc.lat }), null);

    const status = S.planIncidentUpdate(inc, { status: "controlled" });
    assert.ok(status);
    assert.equal(status.title, "Estado: Activo → Controlado");
    assert.equal(status.severity, "notice");
    assert.equal(status.refuse, false);
    assert.deepEqual(status.patch, { status: "controlled" });

    const moved = S.planIncidentUpdate(inc, { lat: inc.lat + 0.001 });
    assert.ok(moved);
    assert.equal(moved.refuse, true);
    assert.equal(moved.patch.lng, inc.lng);
    assert.match(moved.changes[0], /^Ubicación corregida \(1\d\d m\)$/);

    const type = S.planIncidentUpdate(inc, { type: "hazmat", description: "Bodega química" });
    assert.ok(type);
    assert.equal(type.refuse, true);
    assert.deepEqual(type.changes, ["Tipo: Incendio estructural → Materiales peligrosos", "Descripción actualizada"]);
    assert.equal(type.title, "Tipo: Incendio estructural → Materiales peligrosos y 1 cambio más");
  });

  test("updateCommandIncident aplica, registra el evento y avisa si hay que refusionar", async () => {
    const inc = await newIncident({ address: "Editar" });
    const r1 = await S.updateCommandIncident(store, inc.id, { status: "closed", verified: false }, BY);
    assert.equal(r1.incident.status, "closed");
    assert.equal(r1.incident.verified, false);
    assert.equal(r1.refuse, false);
    assert.equal(r1.incident.rev, await store.getIncidentRev(inc.id));
    const [last] = await store.listEvents(inc.id, 1);
    assert.equal(last.kind, "incident_updated");
    assert.match(last.detail, /Estado: Activo → Cerrado · Marcada como no verificada · Por Oficial Pérez/);

    const noop = await S.updateCommandIncident(store, inc.id, { status: "closed" }, BY);
    assert.equal(noop.incident.rev, r1.incident.rev);

    const r2 = await S.updateCommandIncident(store, inc.id, { type: "rescue" }, { name: "Demo", demo: true });
    assert.equal(r2.refuse, true);
    const [last2] = await store.listEvents(inc.id, 1);
    assert.doesNotMatch(last2.detail, /Por /);

    await assert.rejects(
      S.updateCommandIncident(store, "00000000-0000-4000-8000-000000000000", { status: "closed" }, BY),
      { status: 404 },
    );
  });
});
