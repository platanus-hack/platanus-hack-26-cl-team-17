import { test } from "node:test";
import assert from "node:assert/strict";
import type { SplatManifest } from "@/lib/contract";
import type { Incident, Media } from "@/lib/domain";
import type { NewEvent } from "@/lib/store/types";
import { HttpError } from "@/lib/http";
import { handleReconstructionCallback, startReconstruction, type SplatDeps } from "./service";
import { reconstructionToken } from "./token";
import { frame, INCIDENT_ID, media, REC_ID, reconstruction, SCENE } from "./test-fixtures";

function incident(extra: Partial<Incident> = {}): Incident {
  return {
    id: INCIDENT_ID,
    code: "VG-TEST",
    type: "structure_fire",
    title: "Prueba",
    address: "",
    lat: -33.45,
    lng: -70.66,
    status: "active",
    description: "",
    origin: "command",
    verified: true,
    share_key: "k",
    rev: 1,
    situation: null,
    situation_engine: null,
    situation_updated_at: null,
    scene: SCENE,
    scene_engine: "claude",
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
    reconstruction: null,
    created_at: "2026-11-21T10:00:00.000Z",
    updated_at: "2026-11-21T10:00:00.000Z",
    ...extra,
  };
}

function fakeDeps(inc: Incident, mediaList: Media[], over: Partial<SplatDeps> = {}) {
  const state = {
    incident: inc,
    events: [] as NewEvent[],
    uploads: new Map<string, { bytes: Uint8Array; contentType: string }>(),
    runs: [] as Parameters<SplatDeps["runJob"]>[0][],
    locked: false,
  };
  let n = 0;
  const deps: SplatDeps = {
    store: {
      getIncident: async (id) => (id === state.incident.id ? structuredClone(state.incident) : null),
      updateIncident: async (_id, patch) => {
        state.incident = { ...state.incident, ...patch } as Incident;
        return structuredClone(state.incident);
      },
      listMedia: async () => mediaList,
      addEvent: async (e) => {
        state.events.push(e);
        return { ...e, id: "e", at: "x", media_id: null, comm_id: null, mission_id: null };
      },
      acquireLock: async () => {
        if (state.locked) return false;
        state.locked = true;
        return true;
      },
      releaseLock: async () => {
        state.locked = false;
      },
    },
    files: {
      upload: async (path, bytes, contentType) => {
        state.uploads.set(path, { bytes, contentType });
      },
    },
    now: () => new Date("2026-11-21T10:05:00.000Z"),
    splat: "off",
    bucket: "mi-bucket",
    job: "projects/platanus-515411/locations/us-central1/jobs/vigia-splat",
    defaultIterations: 7000,
    runJob: async (input) => {
      state.runs.push(input);
      return { operation: "op-1" };
    },
    newId: () => (n++ === 0 ? REC_ID : `rec-${n}`),
    ...over,
  };
  return { deps, state };
}

const realVideo = media("m1", {
  video_path: `incidents/${INCIDENT_ID}/media/m1/video.mp4`,
  video_status: "uploaded",
  duration_s: 10,
  frames: [frame("m1", 0)],
});

test("sin GPU: 409 con mensaje claro y sin tocar el incidente", async () => {
  const { deps, state } = fakeDeps(incident(), [realVideo]);
  await assert.rejects(startReconstruction(INCIDENT_ID, {}, "http://x", deps), (err: unknown) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 409);
    assert.match(err.message, /No hay GPU/);
    return true;
  });
  assert.equal(state.uploads.size, 0);
  assert.equal(state.runs.length, 0);
  assert.equal(state.locked, false);
});

test("409 si hay una en curso no vencida; se puede relanzar si venció", async () => {
  const active = reconstruction({ status: "training", started_at: "2026-11-21T10:01:00.000Z" });
  const { deps } = fakeDeps(incident({ reconstruction: active }), [realVideo], { splat: "cloud_run_gpu" });
  await assert.rejects(startReconstruction(INCIDENT_ID, {}, "http://x", deps), (err: unknown) => {
    assert.ok(err instanceof HttpError && err.status === 409);
    return true;
  });
  const stale = reconstruction({ status: "queued", requested_at: "2026-11-21T09:00:00.000Z" });
  const second = fakeDeps(incident({ reconstruction: stale }), [realVideo], { splat: "cloud_run_gpu" });
  const rec = await startReconstruction(INCIDENT_ID, {}, "http://x", second.deps);
  assert.equal(rec.status, "queued");
});

test("con GPU: escribe el manifiesto, guarda la reconstrucción en cola y lanza el job", async () => {
  const { deps, state } = fakeDeps(incident(), [realVideo], { splat: "cloud_run_gpu" });
  const rec = await startReconstruction(INCIDENT_ID, { iterations: 3000 }, "https://vigia.example", deps);
  assert.equal(rec.status, "queued");
  assert.equal(rec.backend, "cloud_run_gpu");
  assert.deepEqual(rec.media_ids, ["m1"]);
  assert.equal(rec.frame_count, 30, "10 s × 3 fps");
  assert.equal(rec.iterations, 3000);

  const prefix = `incidents/${INCIDENT_ID}/reconstructions/${REC_ID}/`;
  const file = state.uploads.get(`${prefix}manifest.json`);
  assert.ok(file);
  assert.equal(file.contentType, "application/json");
  const manifest = JSON.parse(new TextDecoder().decode(file.bytes)) as SplatManifest;
  assert.equal(manifest.callback_url, `https://vigia.example/api/internal/reconstruction/${INCIDENT_ID}`);
  assert.equal(manifest.media.length, 1);

  assert.equal(state.runs.length, 1);
  assert.equal(state.runs[0].manifestUri, `gs://mi-bucket/${prefix}manifest.json`);
  assert.equal(state.runs[0].callbackToken, reconstructionToken(INCIDENT_ID, REC_ID));
  assert.equal(state.incident.reconstruction?.id, REC_ID);
});

test("con GPU y sin videos ni cuadros: 409", async () => {
  const { deps } = fakeDeps(incident(), [], { splat: "cloud_run_gpu" });
  await assert.rejects(startReconstruction(INCIDENT_ID, {}, "http://x", deps), /No hay videos ni cuadros/);
});

test("si falla el lanzamiento queda como fallida, con evento y 502", async () => {
  const { deps, state } = fakeDeps(incident(), [realVideo], {
    splat: "cloud_run_gpu",
    runJob: async () => {
      throw Object.assign(new Error("boom"), { response: { status: 403, data: { error: { message: "Permiso denegado" } } } });
    },
  });
  await assert.rejects(startReconstruction(INCIDENT_ID, {}, "http://x", deps), (err: unknown) => {
    assert.ok(err instanceof HttpError && err.status === 502);
    assert.match(err.message, /Permiso denegado \(HTTP 403\)/);
    return true;
  });
  assert.equal(state.incident.reconstruction?.status, "failed");
  assert.match(state.incident.reconstruction?.error ?? "", /Permiso denegado/);
  assert.equal(state.events.at(-1)?.kind, "error");
  assert.equal(state.locked, false);
});

test("callback: token válido aplica el avance; inválido → 401; reemplazada → cancel", async () => {
  const { deps, state } = fakeDeps(incident({ reconstruction: reconstruction() }), []);
  const token = reconstructionToken(INCIDENT_ID, REC_ID);

  const res = await handleReconstructionCallback(
    INCIDENT_ID,
    token,
    { reconstruction_id: REC_ID, status: "training", progress: 0.4, message: "Iteración 2800/7000" },
    deps,
  );
  assert.deepEqual(res, { ok: true, cancel: false });
  assert.equal(state.incident.reconstruction?.status, "training");
  assert.equal(state.incident.reconstruction?.progress, 0.4);

  await assert.rejects(
    handleReconstructionCallback(INCIDENT_ID, "x".repeat(64), { reconstruction_id: REC_ID, status: "training", progress: 0.5, message: "" }, deps),
    (err: unknown) => err instanceof HttpError && err.status === 401,
  );

  const old = "rec-vieja";
  const cancel = await handleReconstructionCallback(
    INCIDENT_ID,
    reconstructionToken(INCIDENT_ID, old),
    { reconstruction_id: old, status: "training", progress: 0.9, message: "" },
    deps,
  );
  assert.deepEqual(cancel, { ok: true, cancel: true });
  assert.equal(state.incident.reconstruction?.progress, 0.4, "no toca la vigente");

  const done = await handleReconstructionCallback(
    INCIDENT_ID,
    token,
    {
      reconstruction_id: REC_ID,
      status: "ready",
      progress: 1,
      message: "",
      splat_path: `incidents/${INCIDENT_ID}/reconstructions/${REC_ID}/scene.splat`,
      alignment: "gps",
      scale_known: true,
    },
    deps,
  );
  assert.deepEqual(done, { ok: true, cancel: false });
  assert.equal(state.incident.reconstruction?.status, "ready");
  assert.equal(state.events.at(-1)?.title, "Reconstrucción 3D lista");
});
