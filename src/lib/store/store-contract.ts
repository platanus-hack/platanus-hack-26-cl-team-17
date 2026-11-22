/**
 * Suite compartida del contrato de `Store` (node:test). La ejecutan tanto
 * local.test.ts como postgres.test.ts, así que solo usa la interfaz `Store`:
 * nada de detalles internos de una implementación.
 *
 * Uso:
 *   runStoreContract("local", async () => ({ store, reset, teardown }));
 *
 * `reset()` se llama antes de cada prueba y debe dejar el store vacío; puede
 * reemplazar `harness.store` (la suite siempre vuelve a leer la propiedad).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { EMPTY_PIPELINE, type Incident, type TelemetryPoint } from "../domain";
import { sha256Hex } from "../ids";
import { StoreNotFoundError, type NewIncident, type NewMedia, type NewMission, type Store } from "./types";

export interface StoreHarness {
  store: Store;
  reset(): Promise<void>;
  teardown(): Promise<void>;
}

/** ISO 8601 en UTC, con o sin fracción de segundo. */
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|\+00:00)$/;

function sleep(msDelay: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, msDelay));
}

function assertIso(value: unknown, field: string): void {
  assert.equal(typeof value, "string", `${field} debe ser string`);
  assert.match(value as string, ISO_UTC_RE, `${field} debe ser ISO 8601 UTC`);
}

/** Recorre el valor y falla si aparece cualquier clave terminada en `_token_hash`. */
function assertNoTokenHash(value: unknown, where: string): void {
  const seen = new Set<unknown>();
  const walk = (v: unknown, at: string): void => {
    if (typeof v !== "object" || v === null || seen.has(v)) return;
    seen.add(v);
    for (const [key, child] of Object.entries(v)) {
      assert.ok(!key.endsWith("_token_hash"), `${where}: expone ${at}.${key}`);
      walk(child, `${at}.${key}`);
    }
  };
  walk(value, "$");
}

function isNotFound(err: unknown): boolean {
  return err instanceof StoreNotFoundError || (err instanceof Error && err.name === "StoreNotFoundError");
}

function newIncidentInput(over: Partial<NewIncident> = {}): NewIncident {
  return {
    type: "structure_fire",
    title: "Incendio estructural — Prueba 123",
    address: "Prueba 123, Santiago",
    lat: -33.4489,
    lng: -70.6693,
    description: "Humo denso en segundo piso.",
    origin: "command",
    verified: true,
    ...over,
  };
}

function newMediaInput(incidentId: string, over: Partial<NewMedia> = {}): NewMedia {
  return {
    incident_id: incidentId,
    source: "citizen",
    kind: "video",
    mime: "video/mp4",
    size_bytes: 1234,
    duration_s: 10,
    lat: -33.449,
    lng: -70.669,
    accuracy_m: 12,
    heading_deg: 90,
    captured_at: "2026-01-01T12:00:00.000Z",
    reporter_note: "Se ve gente en la ventana.",
    upload_token_hash: null,
    video_status: "uploading",
    status: "uploading",
    ...over,
  };
}

function newMissionInput(incidentId: string, over: Partial<NewMission> = {}): NewMission {
  return {
    incident_id: incidentId,
    mode: "device",
    pattern: "orbit",
    radius_m: 60,
    altitude_m: 45,
    speed_ms: 8,
    home_lat: -33.4516,
    home_lng: -70.6693,
    waypoints: [
      { lat: -33.4489, lng: -70.669, alt_m: 45 },
      { lat: -33.4492, lng: -70.6696, alt_m: 45 },
    ],
    ingest_token_hash: sha256Hex(`ingest-${randomUUID()}`),
    ...over,
  };
}

function point(i: number): TelemetryPoint {
  return {
    at: new Date(Date.UTC(2026, 0, 1, 12, 0, 0) + i * 1000).toISOString(),
    lat: -33.4489 + i * 1e-6,
    lng: -70.6693,
    alt_m: 45,
    heading_deg: i % 360,
    speed_ms: 8,
    battery_pct: 90,
  };
}

function frame(idx: number, incidentId: string, mediaId: string) {
  return {
    idx,
    t_s: idx * 2,
    storage_path: `incidents/${incidentId}/media/${mediaId}/frames/${String(idx).padStart(3, "0")}.jpg`,
    width: 1280,
    height: 720,
    lat: null,
    lng: null,
    alt_m: null,
    heading_deg: null,
  };
}

export function runStoreContract(label: string, setup: () => Promise<StoreHarness>): void {
  describe(`Store contract (${label})`, () => {
    let harness: StoreHarness | null = null;
    const s = (): Store => {
      if (!harness) throw new Error("El harness no se inicializó.");
      return harness.store;
    };

    before(async () => {
      harness = await setup();
    });
    after(async () => {
      await harness?.teardown();
    });
    beforeEach(async () => {
      await harness?.reset();
    });

    /** Ejecuta `mutate` y verifica que subió `rev` y avanzó `updated_at`. */
    async function expectBump(incidentId: string, what: string, mutate: () => Promise<unknown>) {
      const prev = await s().getIncident(incidentId);
      assert.ok(prev, "el incidente debe existir");
      // Separa los instantes para poder exigir que updated_at avance estrictamente.
      await sleep(5);
      await mutate();
      const next = await s().getIncident(incidentId);
      assert.ok(next);
      assert.ok(next.rev > prev.rev, `${what}: rev debe subir (${prev.rev} → ${next.rev})`);
      assert.equal(await s().getIncidentRev(incidentId), next.rev, `${what}: getIncidentRev`);
      assertIso(next.updated_at, `${what}: updated_at`);
      assert.ok(
        Date.parse(next.updated_at) > Date.parse(prev.updated_at),
        `${what}: updated_at debe avanzar (${prev.updated_at} → ${next.updated_at})`,
      );
    }

    describe("incidentes", () => {
      it("createIncident devuelve la entidad completa y getIncident/getIncidentByCode la recuperan", async () => {
        const inc = await s().createIncident(newIncidentInput());
        assert.match(inc.id, /^[0-9a-f-]{36}$/i);
        assert.match(inc.code, /^VG-[A-Z0-9]{4}$/);
        assert.equal(inc.type, "structure_fire");
        assert.equal(inc.title, "Incendio estructural — Prueba 123");
        assert.equal(inc.address, "Prueba 123, Santiago");
        assert.equal(inc.lat, -33.4489);
        assert.equal(inc.lng, -70.6693);
        assert.equal(typeof inc.lat, "number");
        assert.equal(inc.status, "active", "status por defecto");
        assert.equal(inc.origin, "command");
        assert.equal(inc.verified, true);
        assert.equal(typeof inc.share_key, "string");
        assert.ok(inc.share_key.length >= 16, "share_key con entropía suficiente");
        assert.equal(typeof inc.rev, "number");
        assert.equal(inc.situation, null);
        assert.equal(inc.scene, null);
        assert.equal(inc.comms_analysis, null);
        assert.deepEqual(inc.pipeline, EMPTY_PIPELINE);
        assertIso(inc.created_at, "created_at");
        assertIso(inc.updated_at, "updated_at");

        assert.deepEqual(await s().getIncident(inc.id), inc);
        assert.deepEqual(await s().getIncidentByCode(inc.code), inc);
        assert.equal(await s().getIncidentRev(inc.id), inc.rev);
      });

      it("respeta status explícito y genera códigos únicos", async () => {
        const a = await s().createIncident(newIncidentInput({ status: "controlled", origin: "citizen", verified: false }));
        assert.equal(a.status, "controlled");
        assert.equal(a.origin, "citizen");
        assert.equal(a.verified, false);
        const many = await Promise.all(Array.from({ length: 8 }, () => s().createIncident(newIncidentInput())));
        const codes = new Set([a.code, ...many.map((i) => i.code)]);
        assert.equal(codes.size, 9);
      });

      it("get* devuelven null para ids desconocidos", async () => {
        const unknown = randomUUID();
        assert.equal(await s().getIncident(unknown), null);
        assert.equal(await s().getIncidentRev(unknown), null);
        assert.equal(await s().getIncidentByCode("VG-ZZZZ"), null);
        assert.equal(await s().getMedia(unknown), null);
        assert.equal(await s().getMission(unknown), null);
        assert.equal(await s().getOpenDroneBatch(unknown), null);
      });

      it("listIncidents lista todos y filtra por status", async () => {
        const active = await s().createIncident(newIncidentInput({ title: "A" }));
        const controlled = await s().createIncident(newIncidentInput({ title: "B", status: "controlled" }));
        const closed = await s().createIncident(newIncidentInput({ title: "C", status: "closed" }));

        const all = await s().listIncidents();
        assert.deepEqual(new Set(all.map((i) => i.id)), new Set([active.id, controlled.id, closed.id]));
        const open = await s().listIncidents({ status: ["active", "controlled"] });
        assert.deepEqual(new Set(open.map((i) => i.id)), new Set([active.id, controlled.id]));
        const onlyClosed = await s().listIncidents({ status: ["closed"] });
        assert.deepEqual(
          onlyClosed.map((i) => i.id),
          [closed.id],
        );
        for (const inc of all) assertNoTokenHash(inc, "listIncidents");
      });

      it("updateIncident aplica el parche, sube rev y fusiona el pipeline superficialmente", async () => {
        const inc = await s().createIncident(newIncidentInput());
        await expectBump(inc.id, "updateIncident", () =>
          s().updateIncident(inc.id, { status: "controlled", title: "Nuevo título", lat: -33.5 }),
        );
        const updated = await s().getIncident(inc.id);
        assert.ok(updated);
        assert.equal(updated.status, "controlled");
        assert.equal(updated.title, "Nuevo título");
        assert.equal(updated.lat, -33.5);
        assert.equal(updated.code, inc.code, "el código no cambia");
        assert.equal(updated.share_key, inc.share_key, "share_key no cambia");
        assert.equal(updated.created_at, inc.created_at);

        const requestedAt = "2026-01-01T12:00:00.000Z";
        await s().updateIncident(inc.id, { pipeline: { fusion_status: "pending", fusion_requested_at: requestedAt } });
        const merged = await s().updateIncident(inc.id, { pipeline: { comms_status: "running" } });
        assert.equal(merged.pipeline.fusion_status, "pending");
        assert.equal(Date.parse(merged.pipeline.fusion_requested_at ?? ""), Date.parse(requestedAt));
        assert.equal(merged.pipeline.comms_status, "running");
        assert.equal(merged.pipeline.fusion_error, null);
        assert.equal(merged.pipeline.comms_finished_at, null);
        assert.deepEqual(
          Object.keys(merged.pipeline).sort(),
          Object.keys(EMPTY_PIPELINE).sort(),
          "el pipeline conserva todas sus claves",
        );
        assert.deepEqual((await s().getIncident(inc.id))?.pipeline, merged.pipeline);

        const errored = await s().updateIncident(inc.id, { pipeline: { fusion_status: "error", fusion_error: "falló" } });
        assert.equal(errored.pipeline.fusion_error, "falló");
        const cleared = await s().updateIncident(inc.id, { pipeline: { fusion_error: null } });
        assert.equal(cleared.pipeline.fusion_error, null, "null explícito limpia el campo");
        assert.equal(cleared.pipeline.fusion_status, "error");
      });

      it("updateIncident guarda situación, escena y análisis como JSON", async () => {
        const inc = await s().createIncident(newIncidentInput());
        // Se guardan tal cual: el store no valida la forma (eso lo hace la capa de IA).
        const situation = { headline: "Fuego en segundo piso", nested: { list: [1, 2, 3] } } as unknown as Incident["situation"];
        const at = new Date().toISOString();
        const updated = await s().updateIncident(inc.id, {
          situation,
          situation_engine: "claude",
          situation_updated_at: at,
        });
        assert.deepEqual(updated.situation, situation);
        assert.equal(updated.situation_engine, "claude");
        assert.equal(Date.parse(updated.situation_updated_at ?? ""), Date.parse(at));
        assert.deepEqual((await s().getIncident(inc.id))?.situation, situation);
      });

      it("update* lanzan StoreNotFoundError para ids desconocidos", async () => {
        const unknown = randomUUID();
        await assert.rejects(s().updateIncident(unknown, { title: "x" }), isNotFound);
        await assert.rejects(s().updateMedia(unknown, { status: "uploaded" }), isNotFound);
        await assert.rejects(s().updateMission(unknown, { status: "landed" }), isNotFound);
        await assert.rejects(s().appendTelemetry(unknown, [point(0)]), isNotFound);
      });
    });

    describe("rev y updated_at", () => {
      it("cada mutación del incidente o de sus hijos sube rev y updated_at", async () => {
        const inc = await s().createIncident(newIncidentInput());
        let mediaId = "";
        let missionId = "";
        await expectBump(inc.id, "createMedia", async () => {
          mediaId = (await s().createMedia(newMediaInput(inc.id))).id;
        });
        await expectBump(inc.id, "updateMedia", () => s().updateMedia(mediaId, { status: "uploaded" }));
        await expectBump(inc.id, "addFrames", () => s().addFrames(mediaId, [frame(0, inc.id, mediaId)]));
        await expectBump(inc.id, "addComm", () =>
          s().addComm({ incident_id: inc.id, text: "Llegando", speaker: "B-1", channel: "1", source: "manual" }),
        );
        await expectBump(inc.id, "createMission", async () => {
          missionId = (await s().createMission(newMissionInput(inc.id))).id;
        });
        await expectBump(inc.id, "updateMission", () => s().updateMission(missionId, { status: "en_route" }));
        await expectBump(inc.id, "appendTelemetry", () => s().appendTelemetry(missionId, [point(0), point(1)]));
        await expectBump(inc.id, "addEvent", () =>
          s().addEvent({ incident_id: inc.id, kind: "alert", severity: "warning", title: "Alerta", detail: "" }),
        );
        await expectBump(inc.id, "updateIncident", () => s().updateIncident(inc.id, { description: "x" }));
      });

      it("mutar un incidente no cambia el rev de otro", async () => {
        const a = await s().createIncident(newIncidentInput());
        const b = await s().createIncident(newIncidentInput());
        const revB = await s().getIncidentRev(b.id);
        await s().createMedia(newMediaInput(a.id));
        await s().addComm({ incident_id: a.id, text: "x", speaker: "", channel: "", source: "manual" });
        await s().updateIncident(a.id, { title: "otro" });
        assert.equal(await s().getIncidentRev(b.id), revB);
      });
    });

    describe("medios", () => {
      it("createMedia/getMedia/updateMedia y nunca exponen el hash del token", async () => {
        const inc = await s().createIncident(newIncidentInput());
        const created = await s().createMedia(newMediaInput(inc.id, { upload_token_hash: sha256Hex("secreto") }));
        assert.equal(created.label, "M1");
        assert.equal(created.incident_id, inc.id);
        assert.equal(created.source, "citizen");
        assert.equal(created.kind, "video");
        assert.equal(created.mission_id, null);
        assert.equal(created.video_path, null);
        assert.equal(created.video_status, "uploading");
        assert.equal(created.status, "uploading");
        assert.equal(created.mime, "video/mp4");
        assert.equal(created.size_bytes, 1234);
        assert.equal(created.duration_s, 10);
        assert.equal(created.lat, -33.449);
        assert.equal(created.heading_deg, 90);
        assert.equal(Date.parse(created.captured_at ?? ""), Date.parse("2026-01-01T12:00:00.000Z"));
        assert.equal(created.reporter_note, "Se ve gente en la ventana.");
        assert.equal(created.error, null);
        assert.equal(created.analysis, null);
        assert.deepEqual(created.frames, []);
        assertIso(created.created_at, "media.created_at");
        assertNoTokenHash(created, "createMedia");

        const got = await s().getMedia(created.id);
        assert.deepEqual(got, created);
        assertNoTokenHash(got, "getMedia");

        const videoPath = `incidents/${inc.id}/media/${created.id}/video.mp4`;
        const updated = await s().updateMedia(created.id, {
          video_path: videoPath,
          video_status: "uploaded",
          status: "uploaded",
          size_bytes: 9999,
        });
        assert.equal(updated.video_path, videoPath);
        assert.equal(updated.video_status, "uploaded");
        assert.equal(updated.status, "uploaded");
        assert.equal(updated.size_bytes, 9999);
        assert.equal(updated.label, "M1");
        assertNoTokenHash(updated, "updateMedia");
        assert.deepEqual(await s().getMedia(created.id), updated);

        const minimal = await s().createMedia({ incident_id: inc.id, source: "responder", kind: "photo" });
        assert.equal(minimal.label, "M2");
        assert.equal(minimal.mime, null);
        assert.equal(minimal.lat, null);
        assert.equal(minimal.captured_at, null);
        assert.equal(minimal.reporter_note, "");
        assert.equal(minimal.video_status, "none");
        assert.equal(minimal.status, "uploading");
      });

      it("labels M<n> secuenciales por incidente, también con creación concurrente", async () => {
        const a = await s().createIncident(newIncidentInput());
        const b = await s().createIncident(newIncidentInput());
        const [listA, listB] = await Promise.all([
          Promise.all(Array.from({ length: 10 }, () => s().createMedia(newMediaInput(a.id)))),
          Promise.all(Array.from({ length: 4 }, () => s().createMedia(newMediaInput(b.id)))),
        ]);
        const labelsA = listA.map((m) => m.label).sort((x, y) => Number(x.slice(1)) - Number(y.slice(1)));
        assert.deepEqual(labelsA, Array.from({ length: 10 }, (_, i) => `M${i + 1}`));
        const labelsB = listB.map((m) => m.label).sort();
        assert.deepEqual(labelsB, ["M1", "M2", "M3", "M4"]);
        const next = await s().createMedia(newMediaInput(a.id));
        assert.equal(next.label, "M11");
      });

      it("addFrames y listMedia devuelven los cuadros ordenados por idx", async () => {
        const inc = await s().createIncident(newIncidentInput());
        const m1 = await s().createMedia(newMediaInput(inc.id, { upload_token_hash: sha256Hex("t1") }));
        const m2 = await s().createMedia(newMediaInput(inc.id, { kind: "photo" }));
        const added = await s().addFrames(m1.id, [frame(2, inc.id, m1.id), frame(0, inc.id, m1.id), frame(1, inc.id, m1.id)]);
        assert.equal(added.length, 3);
        for (const f of added) {
          assert.equal(f.media_id, m1.id);
          assert.equal(typeof f.id, "string");
        }
        await s().addFrames(m2.id, [frame(0, inc.id, m2.id)]);

        const got = await s().getMedia(m1.id);
        assert.deepEqual(
          got?.frames.map((f) => f.idx),
          [0, 1, 2],
        );
        const f0 = got?.frames[0];
        assert.ok(f0);
        assert.equal(f0.storage_path, frame(0, inc.id, m1.id).storage_path);
        assert.equal(f0.width, 1280);
        assert.equal(f0.height, 720);
        assert.equal(f0.t_s, 0);
        assert.equal(f0.lat, null);

        const list = await s().listMedia(inc.id);
        assert.deepEqual(
          list.map((m) => m.id).sort(),
          [m1.id, m2.id].sort(),
        );
        const listed1 = list.find((m) => m.id === m1.id);
        assert.deepEqual(
          listed1?.frames.map((f) => f.idx),
          [0, 1, 2],
        );
        assert.equal(list.find((m) => m.id === m2.id)?.frames.length, 1);
        for (const m of list) assertNoTokenHash(m, "listMedia");
        assert.deepEqual(await s().listMedia(randomUUID()), []);
      });

      it("addFrames guarda la posición de cuadros de dron", async () => {
        const inc = await s().createIncident(newIncidentInput());
        const m = await s().createMedia(newMediaInput(inc.id, { source: "drone", kind: "frames" }));
        const [f] = await s().addFrames(m.id, [
          { ...frame(0, inc.id, m.id), lat: -33.45, lng: -70.67, alt_m: 44.5, heading_deg: 180 },
        ]);
        assert.equal(f.lat, -33.45);
        assert.equal(f.lng, -70.67);
        assert.equal(f.alt_m, 44.5);
        assert.equal(f.heading_deg, 180);
      });

      it("verifyUploadToken", async () => {
        const inc = await s().createIncident(newIncidentInput());
        const withToken = await s().createMedia(newMediaInput(inc.id, { upload_token_hash: sha256Hex("token-bueno") }));
        const withoutToken = await s().createMedia(newMediaInput(inc.id, { upload_token_hash: null }));
        assert.equal(await s().verifyUploadToken(withToken.id, sha256Hex("token-bueno")), true);
        assert.equal(await s().verifyUploadToken(withToken.id, sha256Hex("token-malo")), false);
        assert.equal(await s().verifyUploadToken(withToken.id, ""), false);
        assert.equal(await s().verifyUploadToken(withoutToken.id, sha256Hex("token-bueno")), false);
        assert.equal(await s().verifyUploadToken(withoutToken.id, ""), false);
        assert.equal(await s().verifyUploadToken(randomUUID(), sha256Hex("token-bueno")), false);
      });

      it("getOpenDroneBatch: null, lote abierto y cerrado tras cambiar el estado", async () => {
        const inc = await s().createIncident(newIncidentInput());
        const mission = await s().createMission(newMissionInput(inc.id));
        assert.equal(await s().getOpenDroneBatch(mission.id), null);

        // Un medio de vecino o ya subido no es un lote abierto.
        await s().createMedia(newMediaInput(inc.id, { source: "citizen", kind: "frames", status: "uploading" }));
        await s().createMedia(
          newMediaInput(inc.id, { source: "drone", kind: "frames", status: "uploaded", mission_id: mission.id }),
        );
        assert.equal(await s().getOpenDroneBatch(mission.id), null);

        const batch = await s().createMedia(
          newMediaInput(inc.id, {
            source: "drone",
            kind: "frames",
            status: "uploading",
            video_status: "none",
            mission_id: mission.id,
            upload_token_hash: null,
          }),
        );
        assert.equal(batch.mission_id, mission.id);
        const open = await s().getOpenDroneBatch(mission.id);
        assert.equal(open?.id, batch.id);
        assertNoTokenHash(open, "getOpenDroneBatch");

        const other = await s().createMission(newMissionInput(inc.id));
        assert.equal(await s().getOpenDroneBatch(other.id), null, "el lote es por misión");

        await s().updateMedia(batch.id, { status: "uploaded" });
        assert.equal(await s().getOpenDroneBatch(mission.id), null);
      });
    });

    describe("comunicaciones", () => {
      it("addComm asigna seq 1, 2… por incidente y listComms los ordena", async () => {
        const a = await s().createIncident(newIncidentInput());
        const b = await s().createIncident(newIncidentInput());
        const at = "2026-01-01T12:00:00.000Z";
        const first = await s().addComm({
          incident_id: a.id,
          text: "Central a B-1",
          speaker: "Central",
          channel: "2",
          source: "dictation",
          at,
        });
        assert.equal(first.seq, 1);
        assert.equal(first.incident_id, a.id);
        assert.equal(first.text, "Central a B-1");
        assert.equal(first.speaker, "Central");
        assert.equal(first.channel, "2");
        assert.equal(first.source, "dictation");
        assert.equal(Date.parse(first.at), Date.parse(at));
        assertIso(first.at, "comm.at");
        assertIso(first.created_at, "comm.created_at");

        assert.equal(first.audio_path, null, "sin grabación → null");

        const noAt = await s().addComm({ incident_id: a.id, text: "Sin hora", speaker: "", channel: "", source: "manual" });
        assert.equal(noAt.seq, 2);
        assertIso(noAt.at, "comm.at por defecto");

        const concurrent = await Promise.all([
          ...Array.from({ length: 10 }, (_, i) =>
            s().addComm({ incident_id: a.id, text: `a${i}`, speaker: "", channel: "", source: "manual" }),
          ),
          ...Array.from({ length: 3 }, (_, i) =>
            s().addComm({ incident_id: b.id, text: `b${i}`, speaker: "", channel: "", source: "import" }),
          ),
        ]);
        const seqA = concurrent.filter((c) => c.incident_id === a.id).map((c) => c.seq).sort((x, y) => x - y);
        assert.deepEqual(seqA, Array.from({ length: 10 }, (_, i) => i + 3));
        const seqB = concurrent.filter((c) => c.incident_id === b.id).map((c) => c.seq).sort((x, y) => x - y);
        assert.deepEqual(seqB, [1, 2, 3]);

        const list = await s().listComms(a.id);
        assert.deepEqual(
          list.map((c) => c.seq),
          Array.from({ length: 12 }, (_, i) => i + 1),
        );
        assert.deepEqual(list[0], first);
        assert.deepEqual(await s().listComms(randomUUID()), []);
      });

      it("addComm guarda la grabación de la transmisión (audio_path)", async () => {
        const inc = await s().createIncident(newIncidentInput());
        const audioPath = `incidents/${inc.id}/comms/grabacion.weba`;
        const withAudio = await s().addComm({
          incident_id: inc.id,
          text: "B-3 6-3",
          speaker: "B-3",
          channel: "5-2",
          source: "zello",
          audio_path: audioPath,
        });
        assert.equal(withAudio.audio_path, audioPath);
        assert.equal((await s().listComms(inc.id))[0].audio_path, audioPath);
      });
    });

    describe("dron", () => {
      it("createMission/getMission/listMissions/updateMission sin exponer el hash", async () => {
        const inc = await s().createIncident(newIncidentInput());
        const input = newMissionInput(inc.id);
        const created = await s().createMission(input);
        assert.equal(created.label, "D1");
        assert.equal(created.incident_id, inc.id);
        assert.equal(created.status, "planned");
        assert.equal(created.mode, "device");
        assert.equal(created.pattern, "orbit");
        assert.equal(created.radius_m, 60);
        assert.equal(created.altitude_m, 45);
        assert.equal(created.speed_ms, 8);
        assert.equal(created.home_lat, -33.4516);
        assert.deepEqual(created.waypoints, input.waypoints);
        assert.equal(created.command, "continue");
        assert.equal(created.last, null);
        assert.deepEqual(created.track, []);
        assert.equal(created.frames_received, 0);
        assert.equal(created.started_at, null);
        assert.equal(created.ended_at, null);
        assertIso(created.created_at, "mission.created_at");
        assertNoTokenHash(created, "createMission");
        assert.deepEqual(await s().getMission(created.id), created);

        const startedAt = new Date().toISOString();
        const updated = await s().updateMission(created.id, {
          status: "en_route",
          command: "recall",
          started_at: startedAt,
          frames_received: 3,
        });
        assert.equal(updated.status, "en_route");
        assert.equal(updated.command, "recall");
        assert.equal(Date.parse(updated.started_at ?? ""), Date.parse(startedAt));
        assert.equal(updated.frames_received, 3);
        assertNoTokenHash(updated, "updateMission");

        const second = await s().createMission(newMissionInput(inc.id, { mode: "api", pattern: "hover" }));
        assert.equal(second.label, "D2");
        const list = await s().listMissions(inc.id);
        assert.deepEqual(
          list.map((m) => m.id).sort(),
          [created.id, second.id].sort(),
        );
        for (const m of list) assertNoTokenHash(m, "listMissions");
        assert.deepEqual(await s().listMissions(randomUUID()), []);
      });

      it("labels D<n> secuenciales también con creación concurrente", async () => {
        const inc = await s().createIncident(newIncidentInput());
        const created = await Promise.all(Array.from({ length: 6 }, () => s().createMission(newMissionInput(inc.id))));
        assert.deepEqual(created.map((m) => m.label).sort(), ["D1", "D2", "D3", "D4", "D5", "D6"]);
      });

      it("appendTelemetry acota la traza a 300 y actualiza last", async () => {
        const inc = await s().createIncident(newIncidentInput());
        const mission = await s().createMission(newMissionInput(inc.id));
        const first = await s().appendTelemetry(mission.id, [point(0), point(1)]);
        assert.equal(first.track.length, 2);
        assert.deepEqual(first.last, point(1));
        assertNoTokenHash(first, "appendTelemetry");

        await s().appendTelemetry(
          mission.id,
          Array.from({ length: 250 }, (_, i) => point(i + 2)),
        );
        const capped = await s().appendTelemetry(
          mission.id,
          Array.from({ length: 100 }, (_, i) => point(i + 252)),
        );
        assert.equal(capped.track.length, 300);
        assert.deepEqual(capped.track[0], point(52), "se conservan los últimos 300");
        assert.deepEqual(capped.track[299], point(351));
        assert.deepEqual(capped.last, point(351));
        const reread = await s().getMission(mission.id);
        assert.equal(reread?.track.length, 300);
        assert.deepEqual(reread?.last, point(351));
      });

      it("verifyIngestToken", async () => {
        const inc = await s().createIncident(newIncidentInput());
        const hash = sha256Hex("ingesta-buena");
        const mission = await s().createMission(newMissionInput(inc.id, { ingest_token_hash: hash }));
        assert.equal(await s().verifyIngestToken(mission.id, hash), true);
        assert.equal(await s().verifyIngestToken(mission.id, sha256Hex("ingesta-mala")), false);
        assert.equal(await s().verifyIngestToken(mission.id, ""), false);
        assert.equal(await s().verifyIngestToken(randomUUID(), hash), false);
      });
    });

    describe("conteos", () => {
      it("getIncidentCounts con varios ids, incluidos los sin hijos", async () => {
        const a = await s().createIncident(newIncidentInput());
        const b = await s().createIncident(newIncidentInput());
        const c = await s().createIncident(newIncidentInput());
        await s().createMedia(newMediaInput(a.id));
        await s().createMedia(newMediaInput(a.id, { kind: "photo" }));
        await s().createMedia(newMediaInput(c.id));
        await s().addComm({ incident_id: a.id, text: "uno", speaker: "", channel: "", source: "manual" });
        await s().addComm({ incident_id: a.id, text: "dos", speaker: "", channel: "", source: "manual" });
        await s().addComm({ incident_id: a.id, text: "tres", speaker: "", channel: "", source: "manual" });
        const flying = await s().createMission(newMissionInput(a.id));
        const landed = await s().createMission(newMissionInput(a.id));
        const aborted = await s().createMission(newMissionInput(a.id));
        await s().updateMission(flying.id, { status: "on_station" });
        await s().updateMission(landed.id, { status: "landed" });
        await s().updateMission(aborted.id, { status: "aborted" });
        await s().createMission(newMissionInput(c.id)); // planned cuenta como activa

        const counts = await s().getIncidentCounts([a.id, b.id, c.id]);
        assert.deepEqual(counts[a.id], { media: 2, comms: 3, active_missions: 1 });
        assert.deepEqual(counts[b.id], { media: 0, comms: 0, active_missions: 0 });
        assert.deepEqual(counts[c.id], { media: 1, comms: 0, active_missions: 1 });

        const onlyB = await s().getIncidentCounts([b.id]);
        assert.deepEqual(Object.keys(onlyB), [b.id]);
        assert.deepEqual(await s().getIncidentCounts([]), {});
      });
    });

    describe("línea de tiempo", () => {
      it("addEvent y listEvents: más recientes primero, con límite", async () => {
        const inc = await s().createIncident(newIncidentInput());
        const media = await s().createMedia(newMediaInput(inc.id));
        const base = Date.UTC(2026, 0, 1, 12, 0, 0);
        const ats = [3, 0, 4, 1, 2].map((m) => new Date(base + m * 60_000).toISOString());
        for (const [i, at] of ats.entries()) {
          const ev = await s().addEvent({
            incident_id: inc.id,
            kind: "media_received",
            severity: "notice",
            title: `Evento ${i}`,
            detail: "detalle",
            at,
            media_id: i === 0 ? media.id : null,
          });
          assert.equal(Date.parse(ev.at), Date.parse(at));
          assertIso(ev.at, "event.at");
          assert.equal(ev.comm_id, null);
          assert.equal(ev.mission_id, null);
        }
        const all = await s().listEvents(inc.id);
        assert.equal(all.length, 5);
        assert.deepEqual(
          all.map((e) => Date.parse(e.at)),
          [4, 3, 2, 1, 0].map((m) => base + m * 60_000),
          "orden: más reciente primero",
        );
        const withMedia = all[1];
        assert.equal(withMedia.title, "Evento 0");
        assert.equal(withMedia.media_id, media.id);
        assert.equal(withMedia.kind, "media_received");
        assert.equal(withMedia.severity, "notice");
        assert.equal(withMedia.detail, "detalle");

        const limited = await s().listEvents(inc.id, 2);
        assert.deepEqual(
          limited.map((e) => e.id),
          all.slice(0, 2).map((e) => e.id),
        );

        const now = await s().addEvent({ incident_id: inc.id, kind: "alert", severity: "critical", title: "Ahora", detail: "" });
        assertIso(now.at, "event.at por defecto");
        assert.equal((await s().listEvents(inc.id, 1))[0].id, now.id);
        assert.deepEqual(await s().listEvents(randomUUID()), []);
      });
    });

    describe("candados", () => {
      it("acquireLock / releaseLock / expiración", async () => {
        const inc = await s().createIncident(newIncidentInput());
        const other = await s().createIncident(newIncidentInput());
        assert.equal(await s().acquireLock(inc.id, "fusion", 60), true);
        assert.equal(await s().acquireLock(inc.id, "fusion", 60), false);
        assert.equal(await s().acquireLock(inc.id, "comms", 60), true, "otro nombre es otro candado");
        assert.equal(await s().acquireLock(other.id, "fusion", 60), true, "otro incidente es otro candado");

        await s().releaseLock(inc.id, "fusion");
        assert.equal(await s().acquireLock(inc.id, "fusion", 60), true);
        await s().releaseLock(inc.id, "nunca-tomado"); // no lanza

        assert.equal(await s().acquireLock(inc.id, "corto", 1), true);
        assert.equal(await s().acquireLock(inc.id, "corto", 1), false);
        await sleep(1200);
        assert.equal(await s().acquireLock(inc.id, "corto", 1), true, "expira tras ttl");
        assert.equal(await s().acquireLock(inc.id, "comms", 60), false, "el de ttl largo sigue tomado");
      });

      it("acquireLock concurrente: solo uno lo obtiene", async () => {
        const inc = await s().createIncident(newIncidentInput());
        const results = await Promise.all(Array.from({ length: 8 }, () => s().acquireLock(inc.id, "fusion", 30)));
        assert.equal(results.filter(Boolean).length, 1);
      });
    });
  });
}
