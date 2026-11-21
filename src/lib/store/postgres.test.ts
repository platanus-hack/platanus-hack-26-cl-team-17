/**
 * Pruebas del store de Postgres contra una base real.
 *
 *   TEST_DATABASE_URL=postgresql://postgres:vigia@localhost:55432/postgres \
 *     node --import tsx --test src/lib/store/postgres.test.ts
 *
 * ¡Ojo! Vacía las tablas de esa base (TRUNCATE ... CASCADE) antes de cada prueba.
 * Sin TEST_DATABASE_URL se registra una sola prueba omitida.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it, test } from "node:test";
import { sha256Hex } from "../ids";
import { runStoreContract, type StoreHarness } from "./store-contract";
import type { Store } from "./types";

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL ?? "").trim();

type PgModules = {
  migrate: typeof import("./pg-migrate").migrate;
  getPool: typeof import("./pg-pool").getPool;
  withTransaction: typeof import("./pg-pool").withTransaction;
  closePool: typeof import("./pg-pool").closePool;
  createPostgresStore: typeof import("./postgres").createPostgresStore;
};

/** Configura el entorno ANTES de cargar los módulos que leen la configuración. */
async function loadPg(): Promise<PgModules> {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.VIGIA_AUTO_MIGRATE = "1";
  const [migrator, pool, postgres] = await Promise.all([
    import("./pg-migrate"),
    import("./pg-pool"),
    import("./postgres"),
  ]);
  return {
    migrate: migrator.migrate,
    getPool: pool.getPool,
    withTransaction: pool.withTransaction,
    closePool: pool.closePool,
    createPostgresStore: postgres.createPostgresStore,
  };
}

async function truncateAll(pg: PgModules): Promise<void> {
  await pg.getPool().query("truncate incidents, staff, locks restart identity cascade");
}

if (!TEST_DATABASE_URL) {
  test("store de Postgres", {
    skip:
      "TEST_DATABASE_URL no está definido: se omiten las pruebas contra Postgres " +
      "(p. ej. TEST_DATABASE_URL=postgresql://postgres:vigia@localhost:55432/postgres).",
  }, () => {});
} else {
  runStoreContract("postgres", async (): Promise<StoreHarness> => {
    const pg = await loadPg();
    await pg.migrate();
    return {
      store: pg.createPostgresStore(),
      reset: () => truncateAll(pg),
      teardown: () => pg.closePool(),
    };
  });

  describe("Postgres: específicas", () => {
    let pg: PgModules;
    let store: Store;

    before(async () => {
      pg = await loadPg();
      await pg.migrate();
      store = pg.createPostgresStore();
    });
    after(async () => {
      await pg.closePool();
    });
    beforeEach(async () => {
      await truncateAll(pg);
    });

    const newIncident = () =>
      store.createIncident({
        type: "vehicle_fire",
        title: "Incendio vehicular — Prueba",
        address: "Ruta 68 km 10",
        lat: -33.45,
        lng: -70.7,
        description: "",
        origin: "command",
        verified: true,
      });

    async function revDelta(incidentId: string, mutate: () => Promise<unknown>): Promise<number> {
      const prevRev = await store.getIncidentRev(incidentId);
      await mutate();
      const nextRev = await store.getIncidentRev(incidentId);
      assert.ok(prevRev !== null && nextRev !== null);
      return nextRev - prevRev;
    }

    it("la migración queda registrada y un segundo migrate() no aplica nada", async () => {
      const { rows } = await pg
        .getPool()
        .query<{ name: string; applied_at: Date }>("select name, applied_at from schema_migrations order by name");
      assert.ok(rows.some((r) => r.name === "0001_init.sql"), "0001_init.sql registrada");
      assert.ok(rows.every((r) => r.applied_at instanceof Date));
      assert.deepEqual(await pg.migrate(), []);
      // Dos migradores a la vez: el candado consultivo los serializa y ninguno falla.
      assert.deepEqual(await Promise.all([pg.migrate(), pg.migrate()]), [[], []]);
    });

    it("rev sube exactamente 1 por mutación (incluye next_seq y upserts de cuadros)", async () => {
      const inc = await newIncident();
      assert.equal(inc.rev, 1);
      let mediaId = "";
      let missionId = "";

      assert.equal(
        await revDelta(inc.id, async () => {
          mediaId = (await store.createMedia({ incident_id: inc.id, source: "citizen", kind: "video" })).id;
        }),
        1,
        "createMedia (next_seq + insert)",
      );
      const frame = (idx: number, path = `p${idx}.jpg`) => ({
        idx,
        t_s: idx,
        storage_path: path,
        width: 640,
        height: 360,
        lat: null,
        lng: null,
        alt_m: null,
        heading_deg: null,
      });
      assert.equal(
        await revDelta(inc.id, () => store.addFrames(mediaId, [frame(0), frame(1), frame(2)])),
        1,
        "addFrames con 3 cuadros",
      );
      const firstIds = (await store.getMedia(mediaId))?.frames.map((f) => f.id);
      assert.equal(
        await revDelta(inc.id, () => store.addFrames(mediaId, [frame(2, "otra.jpg"), frame(3)])),
        1,
        "upsert de cuadros (dispara INSERT y UPDATE)",
      );
      const media = await store.getMedia(mediaId);
      assert.deepEqual(media?.frames.map((f) => f.idx), [0, 1, 2, 3]);
      assert.equal(media?.frames[2].storage_path, "otra.jpg", "el idx repetido se reemplaza");
      assert.equal(media?.frames[2].id, firstIds?.[2], "y conserva su id");

      assert.equal(await revDelta(inc.id, () => store.updateMedia(mediaId, { status: "uploaded" })), 1, "updateMedia");
      assert.equal(
        await revDelta(inc.id, () =>
          store.addComm({ incident_id: inc.id, text: "x", speaker: "", channel: "", source: "manual" }),
        ),
        1,
        "addComm",
      );
      assert.equal(
        await revDelta(inc.id, async () => {
          missionId = (
            await store.createMission({
              incident_id: inc.id,
              mode: "simulated",
              pattern: "orbit",
              radius_m: 50,
              altitude_m: 40,
              speed_ms: 6,
              home_lat: -33.45,
              home_lng: -70.7,
              waypoints: [],
              ingest_token_hash: sha256Hex("t"),
            })
          ).id;
        }),
        1,
        "createMission",
      );
      const pt = { at: new Date().toISOString(), lat: -33.45, lng: -70.7, alt_m: 40, heading_deg: 0, speed_ms: null, battery_pct: null };
      assert.equal(await revDelta(inc.id, () => store.appendTelemetry(missionId, [pt, pt])), 1, "appendTelemetry");
      assert.equal(await revDelta(inc.id, () => store.appendTelemetry(missionId, [])), 0, "telemetría vacía no cambia nada");
      assert.equal(await revDelta(inc.id, () => store.updateMission(missionId, { status: "landed" })), 1, "updateMission");
      assert.equal(
        await revDelta(inc.id, () =>
          store.addEvent({ incident_id: inc.id, kind: "drone", severity: "info", title: "t", detail: "" }),
        ),
        1,
        "addEvent",
      );
      assert.equal(await revDelta(inc.id, () => store.updateIncident(inc.id, { title: "otro" })), 1, "updateIncident");
      assert.equal(
        await revDelta(inc.id, () => store.updateIncident(inc.id, { pipeline: { fusion_status: "pending" } })),
        1,
        "updateIncident (pipeline)",
      );

      // Varias mutaciones en una transacción: una sola subida.
      assert.equal(
        await revDelta(inc.id, () =>
          pg.withTransaction(async (client) => {
            await client.query("update incidents set title = 'tx' where id = $1", [inc.id]);
            await client.query("insert into comms (incident_id, text) values ($1, 'tx')", [inc.id]);
            await client.query("insert into events (incident_id, kind) values ($1, 'alert')", [inc.id]);
          }),
        ),
        1,
        "transacción con 3 mutaciones",
      );

      // Mutaciones que no afectan filas no tocan el incidente.
      assert.equal(
        await revDelta(inc.id, () =>
          pg.getPool().query("update media set status = 'failed' where id = $1", [randomUUID()]),
        ),
        0,
        "UPDATE sin filas",
      );
      assert.equal(
        await revDelta(inc.id, () => store.acquireLock(inc.id, "fusion", 30)),
        0,
        "los candados no son cambios del incidente",
      );
    });

    it("una transacción fallida no deja rastro (rev ni contadores)", async () => {
      const inc = await newIncident();
      const rev = await store.getIncidentRev(inc.id);
      await assert.rejects(
        pg.withTransaction(async (client) => {
          await client.query("insert into media (incident_id, source, kind) values ($1, 'citizen', 'video')", [inc.id]);
          throw new Error("abortar");
        }),
        /abortar/,
      );
      assert.equal(await store.getIncidentRev(inc.id), rev);
      const m = await store.createMedia({ incident_id: inc.id, source: "citizen", kind: "photo" });
      assert.equal(m.label, "M1", "el contador volvió atrás con el ROLLBACK");
    });

    it("acquire_lock concurrente: 10 intentos en paralelo → exactamente uno gana", async () => {
      const inc = await newIncident();
      const pool = pg.getPool();
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          pool.query<{ ok: boolean }>("select acquire_lock($1, 'fusion', 30) as ok", [inc.id]),
        ),
      );
      assert.equal(results.filter((r) => r.rows[0].ok).length, 1);
      const viaStore = await Promise.all(Array.from({ length: 10 }, () => store.acquireLock(inc.id, "comms", 30)));
      assert.equal(viaStore.filter(Boolean).length, 1);
      assert.equal(await store.acquireLock(randomUUID(), "fusion", 30), false, "incidente inexistente");
    });

    it("ids que no son uuid: get* → null, update* → StoreNotFoundError, verify* → false", async () => {
      const bad = "no-es-un-uuid";
      assert.equal(await store.getIncident(bad), null);
      assert.equal(await store.getIncidentRev(bad), null);
      assert.equal(await store.getMedia(bad), null);
      assert.equal(await store.getMission(bad), null);
      assert.equal(await store.getOpenDroneBatch(bad), null);
      assert.deepEqual(await store.listMedia(bad), []);
      assert.deepEqual(await store.listEvents(bad), []);
      assert.equal(await store.verifyUploadToken(bad, "x"), false);
      assert.equal(await store.verifyIngestToken(bad, "x"), false);
      assert.equal(await store.acquireLock(bad, "fusion", 10), false);
      assert.deepEqual(await store.getIncidentCounts([bad]), { [bad]: { media: 0, comms: 0, active_missions: 0 } });
      const isNotFound = (err: unknown) => err instanceof Error && err.name === "StoreNotFoundError";
      await assert.rejects(store.updateIncident(bad, { title: "x" }), isNotFound);
      await assert.rejects(store.updateMedia(bad, { status: "failed" }), isNotFound);
      await assert.rejects(store.addFrames(bad, []), isNotFound);
      await assert.rejects(store.addFrames(randomUUID(), []), isNotFound);
      await assert.rejects(
        store.createMedia({ incident_id: randomUUID(), source: "citizen", kind: "video" }),
        isNotFound,
      );
      await assert.rejects(
        store.addComm({ incident_id: randomUUID(), text: "x", speaker: "", channel: "", source: "manual" }),
        isNotFound,
      );
    });

    it("borrar un incidente borra sus hijos en cascada", async () => {
      const inc = await newIncident();
      const m = await store.createMedia({ incident_id: inc.id, source: "citizen", kind: "video" });
      await store.addFrames(m.id, [
        { idx: 0, t_s: 0, storage_path: "a.jpg", width: 1, height: 1, lat: null, lng: null, alt_m: null, heading_deg: null },
      ]);
      await store.addComm({ incident_id: inc.id, text: "x", speaker: "", channel: "", source: "manual" });
      await store.addEvent({ incident_id: inc.id, kind: "alert", severity: "info", title: "t", detail: "", media_id: m.id });
      await store.acquireLock(inc.id, "fusion", 30);
      await pg.getPool().query("delete from incidents where id = $1", [inc.id]);
      const { rows } = await pg.getPool().query<{ n: number }>(
        `select (select count(*) from media) + (select count(*) from media_frames) + (select count(*) from comms)
              + (select count(*) from events) + (select count(*) from locks) as n`,
      );
      assert.equal(rows[0].n, 0);
    });

    it("tipos: numeric e int8 llegan como number", async () => {
      const { rows } = await pg
        .getPool()
        .query<{ a: unknown; b: unknown }>("select 12.5::numeric as a, 9007199254740::int8 as b");
      assert.equal(rows[0].a, 12.5);
      assert.equal(rows[0].b, 9007199254740);
    });

    it("staff: email en minúsculas, único y con rol válido", async () => {
      const pool = pg.getPool();
      await pool.query(
        "insert into staff (email, name, role, password_hash) values ('oficial@vigia.local', 'Oficial', 'officer', 'x')",
      );
      const { rows } = await pool.query<{ id: string; active: boolean; last_login_at: Date | null }>(
        "select id, active, last_login_at from staff",
      );
      assert.equal(rows[0].active, true);
      assert.equal(rows[0].last_login_at, null);
      await assert.rejects(
        pool.query("insert into staff (email, name, role, password_hash) values ('Mayus@vigia.local', 'M', 'officer', 'x')"),
        (err: unknown) => (err as { code?: string }).code === "23514",
      );
      await assert.rejects(
        pool.query("insert into staff (email, name, role, password_hash) values ('oficial@vigia.local', 'O', 'admin', 'x')"),
        (err: unknown) => (err as { code?: string }).code === "23505",
      );
      await assert.rejects(
        pool.query("insert into staff (email, name, role, password_hash) values ('otro@vigia.local', 'O', 'jefe', 'x')"),
        (err: unknown) => (err as { code?: string }).code === "23514",
      );
    });
  });
}
