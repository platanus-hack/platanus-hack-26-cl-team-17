/**
 * Store de producción sobre Postgres (Cloud SQL) con node-postgres. Solo servidor.
 *
 * El esquema está en db/migrations/0001_init.sql. Las reglas del contrato se
 * cumplen en la base:
 *  - rev/updated_at: triggers (una vez por transacción; ver sección 4 de la migración).
 *  - M<n>/D<n>/seq: next_seq dentro del mismo INSERT (bloquea la fila del incidente).
 *  - track acotado a 300: append_telemetry.
 * Aquí: consultas parametrizadas, mapeo fila → entidad (sin columnas internas ni
 * *_token_hash) y fechas como ISO 8601 UTC.
 */
import type { QueryResultRow } from "pg";
import {
  EMPTY_PIPELINE,
  type AnalysisEngine,
  type CommEntry,
  type DroneMission,
  type Incident,
  type Media,
  type MediaFrame,
  type PipelineState,
  type TelemetryPoint,
  type TimelineEvent,
} from "../domain";
import { newIncidentCode, newToken, safeEqual } from "../ids";
import { ensureMigrated } from "./pg-migrate";
import { getPool } from "./pg-pool";
import {
  StoreNotFoundError,
  type IncidentPatch,
  type MediaPatch,
  type MissionPatch,
  type NewFrame,
  type Store,
} from "./types";

const DEFAULT_EVENT_LIMIT = 200;
const CODE_ATTEMPTS = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ───────────────────────────── Filas ───────────────────────────── */

interface IncidentRow {
  id: string;
  code: string;
  type: Incident["type"];
  title: string;
  address: string;
  lat: number;
  lng: number;
  status: Incident["status"];
  description: string;
  origin: Incident["origin"];
  verified: boolean;
  share_key: string;
  rev: number;
  situation: Incident["situation"];
  situation_engine: AnalysisEngine | null;
  situation_updated_at: Date | null;
  scene: Incident["scene"];
  scene_engine: AnalysisEngine | null;
  scene_updated_at: Date | null;
  comms_analysis: Incident["comms_analysis"];
  comms_engine: AnalysisEngine | null;
  comms_analysis_updated_at: Date | null;
  reconstruction: Incident["reconstruction"];
  pipeline: Partial<PipelineState> | null;
  created_at: Date;
  updated_at: Date;
}

interface MediaRow {
  id: string;
  incident_id: string;
  label: string;
  source: Media["source"];
  kind: Media["kind"];
  mission_id: string | null;
  video_path: string | null;
  video_status: Media["video_status"];
  mime: string | null;
  size_bytes: number | null;
  duration_s: number | null;
  lat: number | null;
  lng: number | null;
  accuracy_m: number | null;
  heading_deg: number | null;
  captured_at: Date | null;
  reporter_note: string;
  status: Media["status"];
  error: string | null;
  analysis: Media["analysis"];
  analysis_engine: AnalysisEngine | null;
  analyzed_at: Date | null;
  /** jsonb ya ordenado por idx (ver MEDIA_SELECT). */
  frames: MediaFrame[] | null;
  created_at: Date;
}

interface FrameRow {
  id: string;
  media_id: string;
  idx: number;
  t_s: number;
  storage_path: string;
  width: number;
  height: number;
  lat: number | null;
  lng: number | null;
  alt_m: number | null;
  heading_deg: number | null;
}

interface CommRow {
  id: string;
  incident_id: string;
  seq: number;
  at: Date;
  channel: string;
  speaker: string;
  text: string;
  source: CommEntry["source"];
  audio_path: string | null;
  created_at: Date;
}

interface MissionRow {
  id: string;
  incident_id: string;
  label: string;
  status: DroneMission["status"];
  mode: DroneMission["mode"];
  pattern: DroneMission["pattern"];
  radius_m: number;
  altitude_m: number;
  speed_ms: number;
  home_lat: number;
  home_lng: number;
  waypoints: DroneMission["waypoints"] | null;
  command: DroneMission["command"];
  last: TelemetryPoint | null;
  track: TelemetryPoint[] | null;
  frames_received: number;
  created_at: Date;
  started_at: Date | null;
  ended_at: Date | null;
}

interface EventRow {
  id: string;
  incident_id: string;
  at: Date;
  kind: TimelineEvent["kind"];
  severity: TimelineEvent["severity"];
  title: string;
  detail: string;
  media_id: string | null;
  comm_id: string | null;
  mission_id: string | null;
}

/* ──────────────────── Columnas (nunca *_token_hash) ──────────────────── */

const INCIDENT_COLS = `id, code, type, title, address, lat, lng, status, description, origin,
  verified, share_key, rev, situation, situation_engine, situation_updated_at, scene,
  scene_engine, scene_updated_at, comms_analysis, comms_engine, comms_analysis_updated_at,
  reconstruction, pipeline, created_at, updated_at`;

const MEDIA_BASE_COLS = `id, incident_id, label, source, kind, mission_id, video_path,
  video_status, mime, size_bytes, duration_s, lat, lng, accuracy_m, heading_deg, captured_at,
  reporter_note, status, error, analysis, analysis_engine, analyzed_at, created_at`;

const FRAME_COLS = `id, media_id, idx, t_s, storage_path, width, height, lat, lng, alt_m, heading_deg`;

/** Medio con sus cuadros ordenados por idx en una sola consulta. Alias obligatorio: m. */
const MEDIA_SELECT = `select ${MEDIA_BASE_COLS.split(",")
  .map((c) => `m.${c.trim()}`)
  .join(", ")},
  coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', f.id, 'media_id', f.media_id, 'idx', f.idx, 't_s', f.t_s,
      'storage_path', f.storage_path, 'width', f.width, 'height', f.height,
      'lat', f.lat, 'lng', f.lng, 'alt_m', f.alt_m, 'heading_deg', f.heading_deg
    ) order by f.idx)
    from media_frames f where f.media_id = m.id
  ), '[]'::jsonb) as frames
  from media m`;

const COMM_COLS = `id, incident_id, seq, at, channel, speaker, text, source, audio_path, created_at`;

const MISSION_COLS = `id, incident_id, label, status, mode, pattern, radius_m, altitude_m,
  speed_ms, home_lat, home_lng, waypoints, command, last, track, frames_received, created_at,
  started_at, ended_at`;

const EVENT_COLS = `id, incident_id, at, kind, severity, title, detail, media_id, comm_id, mission_id`;

/* ───────────────────────────── Mapeo ───────────────────────────── */

const iso = (d: Date): string => d.toISOString();
const isoOrNull = (d: Date | null): string | null => (d ? d.toISOString() : null);

function toIncident(r: IncidentRow): Incident {
  return {
    id: r.id,
    code: r.code,
    type: r.type,
    title: r.title,
    address: r.address,
    lat: r.lat,
    lng: r.lng,
    status: r.status,
    description: r.description,
    origin: r.origin,
    verified: r.verified,
    share_key: r.share_key,
    rev: r.rev,
    situation: r.situation,
    situation_engine: r.situation_engine,
    situation_updated_at: isoOrNull(r.situation_updated_at),
    scene: r.scene,
    scene_engine: r.scene_engine,
    scene_updated_at: isoOrNull(r.scene_updated_at),
    comms_analysis: r.comms_analysis,
    comms_engine: r.comms_engine,
    comms_analysis_updated_at: isoOrNull(r.comms_analysis_updated_at),
    reconstruction: r.reconstruction ?? null,
    pipeline: { ...EMPTY_PIPELINE, ...(r.pipeline ?? {}) },
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

function toFrame(r: FrameRow): MediaFrame {
  return {
    id: r.id,
    media_id: r.media_id,
    idx: r.idx,
    t_s: r.t_s,
    storage_path: r.storage_path,
    width: r.width,
    height: r.height,
    lat: r.lat,
    lng: r.lng,
    alt_m: r.alt_m,
    heading_deg: r.heading_deg,
  };
}

function toMedia(r: MediaRow): Media {
  return {
    id: r.id,
    incident_id: r.incident_id,
    label: r.label,
    source: r.source,
    kind: r.kind,
    mission_id: r.mission_id,
    video_path: r.video_path,
    video_status: r.video_status,
    mime: r.mime,
    size_bytes: r.size_bytes,
    duration_s: r.duration_s,
    lat: r.lat,
    lng: r.lng,
    accuracy_m: r.accuracy_m,
    heading_deg: r.heading_deg,
    captured_at: isoOrNull(r.captured_at),
    reporter_note: r.reporter_note,
    status: r.status,
    error: r.error,
    analysis: r.analysis,
    analysis_engine: r.analysis_engine,
    analyzed_at: isoOrNull(r.analyzed_at),
    frames: (r.frames ?? []).map(toFrame),
    created_at: iso(r.created_at),
  };
}

function toComm(r: CommRow): CommEntry {
  return {
    id: r.id,
    incident_id: r.incident_id,
    seq: r.seq,
    at: iso(r.at),
    channel: r.channel,
    speaker: r.speaker,
    text: r.text,
    source: r.source,
    audio_path: r.audio_path ?? null,
    created_at: iso(r.created_at),
  };
}

function toMission(r: MissionRow): DroneMission {
  return {
    id: r.id,
    incident_id: r.incident_id,
    label: r.label,
    status: r.status,
    mode: r.mode,
    pattern: r.pattern,
    radius_m: r.radius_m,
    altitude_m: r.altitude_m,
    speed_ms: r.speed_ms,
    home_lat: r.home_lat,
    home_lng: r.home_lng,
    waypoints: r.waypoints ?? [],
    command: r.command,
    last: r.last,
    track: r.track ?? [],
    frames_received: r.frames_received,
    created_at: iso(r.created_at),
    started_at: isoOrNull(r.started_at),
    ended_at: isoOrNull(r.ended_at),
  };
}

function toEvent(r: EventRow): TimelineEvent {
  return {
    id: r.id,
    incident_id: r.incident_id,
    at: iso(r.at),
    kind: r.kind,
    severity: r.severity,
    title: r.title,
    detail: r.detail,
    media_id: r.media_id,
    comm_id: r.comm_id,
    mission_id: r.mission_id,
  };
}

/* ─────────────────────────── Utilidades ─────────────────────────── */

const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

/** jsonb como parámetro: pg convierte los arrays de JS a arrays de Postgres, así que se serializa a mano. */
function jsonParam(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

/** Fecha de entrada → ISO; si no es válida usa `fallback`. */
function isoOr(value: string | null | undefined, fallback: string | null): string | null {
  if (!value) return fallback;
  const t = Date.parse(value);
  return Number.isNaN(t) ? fallback : new Date(t).toISOString();
}

function pgCode(err: unknown): string {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code: unknown }).code)
    : "";
}

/** FK inexistente (23503) o incidente inexistente en next_seq (P0002) → StoreNotFoundError. */
function rethrowNotFound(err: unknown, what: string): never {
  const code = pgCode(err);
  if (code === "23503" || code === "P0002") throw new StoreNotFoundError(what);
  throw err;
}

async function query<R extends QueryResultRow>(text: string, values: unknown[] = []): Promise<R[]> {
  await ensureMigrated();
  const res = await getPool().query<R>(text, values);
  return res.rows;
}

/* ─────────────────────── Parches permitidos ─────────────────────── */

type ColumnKind = "plain" | "json" | "timestamp";

const INCIDENT_PATCH_COLUMNS: Record<Exclude<keyof IncidentPatch, "pipeline">, ColumnKind> = {
  type: "plain",
  title: "plain",
  address: "plain",
  lat: "plain",
  lng: "plain",
  description: "plain",
  status: "plain",
  verified: "plain",
  situation: "json",
  situation_engine: "plain",
  situation_updated_at: "timestamp",
  scene: "json",
  scene_engine: "plain",
  scene_updated_at: "timestamp",
  comms_analysis: "json",
  comms_engine: "plain",
  comms_analysis_updated_at: "timestamp",
  reconstruction: "json",
};

const MEDIA_PATCH_COLUMNS: Record<keyof MediaPatch, ColumnKind> = {
  video_path: "plain",
  video_status: "plain",
  status: "plain",
  error: "plain",
  analysis: "json",
  analysis_engine: "plain",
  analyzed_at: "timestamp",
  duration_s: "plain",
  mime: "plain",
  size_bytes: "plain",
};

const MISSION_PATCH_COLUMNS: Record<keyof MissionPatch, ColumnKind> = {
  status: "plain",
  command: "plain",
  started_at: "timestamp",
  ended_at: "timestamp",
  frames_received: "plain",
};

const PIPELINE_KEYS = Object.keys(EMPTY_PIPELINE) as (keyof PipelineState)[];

/**
 * Arma "col = $n, ..." con las claves permitidas que vengan definidas. Los
 * nombres de columna salen de las tablas de arriba, nunca del parche.
 */
function buildSets(
  patch: object,
  columns: Record<string, ColumnKind>,
  values: unknown[],
): string[] {
  const sets: string[] = [];
  const source = patch as Record<string, unknown>;
  for (const [column, kind] of Object.entries(columns)) {
    if (!Object.prototype.hasOwnProperty.call(source, column)) continue;
    const value = source[column];
    if (value === undefined) continue;
    if (kind === "json") {
      values.push(jsonParam(value));
      sets.push(`${column} = $${values.length}::jsonb`);
    } else if (kind === "timestamp") {
      values.push(value === null ? null : isoOr(String(value), String(value)));
      sets.push(`${column} = $${values.length}::timestamptz`);
    } else {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    }
  }
  return sets;
}

/* ───────────────────────────── Store ───────────────────────────── */

export function createPostgresStore(): Store {
  const getMediaRow = async (id: string): Promise<MediaRow | null> => {
    if (!isUuid(id)) return null;
    const rows = await query<MediaRow>(`${MEDIA_SELECT} where m.id = $1`, [id]);
    return rows[0] ?? null;
  };

  const store: Store = {
    kind: "postgres",

    /* ── Incidentes ── */

    async listIncidents(opts) {
      // Una lista vacía se trata como "sin filtro" (igual que el store local).
      const statuses = opts?.status?.length ? opts.status : null;
      const rows = await query<IncidentRow>(
        `select ${INCIDENT_COLS} from incidents
          where ($1::text[] is null or status = any($1::text[]))
          order by created_at desc, id`,
        [statuses],
      );
      return rows.map(toIncident);
    },

    async getIncident(id) {
      if (!isUuid(id)) return null;
      const rows = await query<IncidentRow>(`select ${INCIDENT_COLS} from incidents where id = $1`, [
        id,
      ]);
      return rows[0] ? toIncident(rows[0]) : null;
    },

    async getIncidentByCode(code) {
      const wanted = code.trim().toUpperCase();
      if (!wanted) return null;
      const rows = await query<IncidentRow>(
        `select ${INCIDENT_COLS} from incidents where code = $1`,
        [wanted],
      );
      return rows[0] ? toIncident(rows[0]) : null;
    },

    async getIncidentRev(id) {
      if (!isUuid(id)) return null;
      const rows = await query<{ rev: number }>("select rev from incidents where id = $1", [id]);
      return rows[0]?.rev ?? null;
    },

    async createIncident(input) {
      for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
        const rows = await query<IncidentRow>(
          `insert into incidents
             (code, type, title, address, lat, lng, status, description, origin, verified, share_key, pipeline)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
           on conflict (code) do nothing
           returning ${INCIDENT_COLS}`,
          [
            newIncidentCode(),
            input.type,
            input.title,
            input.address,
            input.lat,
            input.lng,
            input.status ?? "active",
            input.description,
            input.origin,
            input.verified,
            newToken(),
            JSON.stringify(EMPTY_PIPELINE),
          ],
        );
        if (rows[0]) return toIncident(rows[0]);
      }
      throw new Error("No se pudo generar un código de incidente único.");
    },

    async updateIncident(id, patch) {
      if (!isUuid(id)) throw new StoreNotFoundError(`incidente ${id}`);
      const values: unknown[] = [id];
      const sets = buildSets(patch, INCIDENT_PATCH_COLUMNS, values);
      if (patch.pipeline) {
        const merge: Partial<PipelineState> = {};
        const src = patch.pipeline as Record<string, unknown>;
        for (const key of PIPELINE_KEYS) {
          if (src[key] !== undefined) (merge as Record<string, unknown>)[key] = src[key];
        }
        values.push(JSON.stringify(merge));
        // Fusión superficial con el estado actual (|| de jsonb).
        sets.push(`pipeline = pipeline || $${values.length}::jsonb`);
      }
      // Sin campos igual cuenta como cambio: el trigger sube rev y updated_at.
      if (sets.length === 0) sets.push("updated_at = now()");
      const rows = await query<IncidentRow>(
        `update incidents set ${sets.join(", ")} where id = $1 returning ${INCIDENT_COLS}`,
        values,
      );
      if (!rows[0]) throw new StoreNotFoundError(`incidente ${id}`);
      return toIncident(rows[0]);
    },

    async getIncidentCounts(ids) {
      const out: Record<string, { media: number; comms: number; active_missions: number }> = {};
      for (const id of ids) out[id] = { media: 0, comms: 0, active_missions: 0 };
      const valid = [...new Set(ids.filter(isUuid))];
      if (valid.length === 0) return out;
      // Una sola consulta para todos los ids. Misión activa = ni aterrizada ni abortada.
      const rows = await query<{
        id: string;
        media: number;
        comms: number;
        active_missions: number;
      }>(
        `select i.id,
                (select count(*) from media m where m.incident_id = i.id)::int as media,
                (select count(*) from comms c where c.incident_id = i.id)::int as comms,
                (select count(*) from drone_missions d
                  where d.incident_id = i.id and d.status not in ('landed','aborted'))::int as active_missions
           from incidents i
          where i.id = any($1::uuid[])`,
        [valid],
      );
      const byLower = new Map(rows.map((r) => [r.id.toLowerCase(), r]));
      for (const id of ids) {
        const r = byLower.get(id.toLowerCase());
        if (r) out[id] = { media: r.media, comms: r.comms, active_missions: r.active_missions };
      }
      return out;
    },

    /* ── Medios ── */

    async listMedia(incidentId) {
      if (!isUuid(incidentId)) return [];
      const rows = await query<MediaRow>(
        `${MEDIA_SELECT} where m.incident_id = $1 order by m.created_at, m.seq`,
        [incidentId],
      );
      return rows.map(toMedia);
    },

    async getMedia(id) {
      const row = await getMediaRow(id);
      return row ? toMedia(row) : null;
    },

    async createMedia(input) {
      if (!isUuid(input.incident_id)) throw new StoreNotFoundError(`incidente ${input.incident_id}`);
      let inserted: { id: string }[];
      try {
        // seq y label los asigna el trigger media_assign_label (next_seq).
        inserted = await query<{ id: string }>(
          `insert into media
             (incident_id, source, kind, mission_id, mime, size_bytes, duration_s, lat, lng,
              accuracy_m, heading_deg, captured_at, reporter_note, upload_token_hash,
              video_status, status)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $13, $14, $15, $16)
           returning id`,
          [
            input.incident_id,
            input.source,
            input.kind,
            input.mission_id ?? null,
            input.mime ?? null,
            input.size_bytes ?? null,
            input.duration_s ?? null,
            input.lat ?? null,
            input.lng ?? null,
            input.accuracy_m ?? null,
            input.heading_deg ?? null,
            isoOr(input.captured_at, null),
            input.reporter_note ?? "",
            input.upload_token_hash ?? null,
            input.video_status ?? "none",
            input.status ?? "uploading",
          ],
        );
      } catch (err) {
        rethrowNotFound(err, `incidente ${input.incident_id} o misión ${input.mission_id ?? "-"}`);
      }
      const row = await getMediaRow(inserted[0].id);
      if (!row) throw new StoreNotFoundError(`medio ${inserted[0].id}`);
      return toMedia(row);
    },

    async updateMedia(id, patch) {
      if (!isUuid(id)) throw new StoreNotFoundError(`medio ${id}`);
      const values: unknown[] = [id];
      const sets = buildSets(patch, MEDIA_PATCH_COLUMNS, values);
      // Sin campos: un UPDATE "vacío" igual dispara el toque al incidente (rev).
      if (sets.length === 0) sets.push("status = status");
      const updated = await query<{ id: string }>(
        `update media set ${sets.join(", ")} where id = $1 returning id`,
        values,
      );
      if (!updated[0]) throw new StoreNotFoundError(`medio ${id}`);
      const row = await getMediaRow(id);
      if (!row) throw new StoreNotFoundError(`medio ${id}`);
      return toMedia(row);
    },

    async addFrames(mediaId, frames) {
      if (!isUuid(mediaId)) throw new StoreNotFoundError(`medio ${mediaId}`);
      if (frames.length === 0) {
        const exists = await query<{ id: string }>("select id from media where id = $1", [mediaId]);
        if (!exists[0]) throw new StoreNotFoundError(`medio ${mediaId}`);
        return [];
      }
      // Un mismo idx dos veces en el lote rompería el upsert: vale el último.
      const byIdx = new Map<number, NewFrame>();
      for (const f of frames) byIdx.set(f.idx, f);
      const batch = [...byIdx.values()];
      // Ids fijados por el llamador: solo esos reemplazan el id de un cuadro existente.
      const explicitIds = batch.map((f) => f.id).filter(isUuid);
      const values: unknown[] = [mediaId, explicitIds];
      const tuples = batch.map((f) => {
        const base = values.length;
        values.push(
          isUuid(f.id) ? f.id : null,
          f.idx,
          f.t_s,
          f.storage_path,
          f.width,
          f.height,
          f.lat ?? null,
          f.lng ?? null,
          f.alt_m ?? null,
          f.heading_deg ?? null,
        );
        const p = (k: number) => `$${base + k}`;
        return `(coalesce(${p(1)}::uuid, gen_random_uuid()), $1::uuid, ${p(2)}::int, ${p(3)}::float8,
                 ${p(4)}::text, ${p(5)}::int, ${p(6)}::int, ${p(7)}::float8, ${p(8)}::float8,
                 ${p(9)}::float8, ${p(10)}::float8)`;
      });
      let rows: FrameRow[];
      try {
        // Reintentar la subida de un mismo idx reemplaza el cuadro y conserva su id.
        rows = await query<FrameRow>(
          `insert into media_frames (${FRAME_COLS})
           select * from (values ${tuples.join(", ")})
             as v(id, media_id, idx, t_s, storage_path, width, height, lat, lng, alt_m, heading_deg)
           on conflict (media_id, idx) do update set
             id = case when excluded.id = any($2::uuid[]) then excluded.id else media_frames.id end,
             t_s = excluded.t_s,
             storage_path = excluded.storage_path,
             width = excluded.width,
             height = excluded.height,
             lat = excluded.lat,
             lng = excluded.lng,
             alt_m = excluded.alt_m,
             heading_deg = excluded.heading_deg
           returning ${FRAME_COLS}`,
          values,
        );
      } catch (err) {
        rethrowNotFound(err, `medio ${mediaId}`);
      }
      const byIdxOut = new Map(rows.map((r) => [r.idx, toFrame(r)]));
      return batch.map((f) => byIdxOut.get(f.idx)).filter((f): f is MediaFrame => Boolean(f));
    },

    async verifyUploadToken(mediaId, tokenHash) {
      if (!isUuid(mediaId) || typeof tokenHash !== "string" || !tokenHash) return false;
      const rows = await query<{ upload_token_hash: string | null }>(
        "select upload_token_hash from media where id = $1",
        [mediaId],
      );
      const expected = rows[0]?.upload_token_hash;
      return expected ? safeEqual(expected, tokenHash) : false;
    },

    async getOpenDroneBatch(missionId) {
      if (!isUuid(missionId)) return null;
      // Si quedara más de uno abierto, vale el más reciente.
      const rows = await query<MediaRow>(
        `${MEDIA_SELECT}
          where m.mission_id = $1 and m.source = 'drone' and m.kind = 'frames' and m.status = 'uploading'
          order by m.seq desc
          limit 1`,
        [missionId],
      );
      return rows[0] ? toMedia(rows[0]) : null;
    },

    /* ── Comunicaciones ── */

    async listComms(incidentId) {
      if (!isUuid(incidentId)) return [];
      const rows = await query<CommRow>(
        `select ${COMM_COLS} from comms where incident_id = $1 order by seq`,
        [incidentId],
      );
      return rows.map(toComm);
    },

    async addComm(input) {
      if (!isUuid(input.incident_id)) throw new StoreNotFoundError(`incidente ${input.incident_id}`);
      try {
        // seq lo asigna el trigger comms_assign_seq (next_seq).
        const rows = await query<CommRow>(
          `insert into comms (incident_id, at, channel, speaker, text, source, audio_path)
           values ($1, coalesce($2::timestamptz, now()), $3, $4, $5, $6, $7)
           returning ${COMM_COLS}`,
          [
            input.incident_id,
            isoOr(input.at, null),
            input.channel,
            input.speaker,
            input.text,
            input.source,
            input.audio_path ?? null,
          ],
        );
        return toComm(rows[0]);
      } catch (err) {
        rethrowNotFound(err, `incidente ${input.incident_id}`);
      }
    },

    /* ── Dron ── */

    async listMissions(incidentId) {
      if (!isUuid(incidentId)) return [];
      const rows = await query<MissionRow>(
        `select ${MISSION_COLS} from drone_missions where incident_id = $1 order by created_at, seq`,
        [incidentId],
      );
      return rows.map(toMission);
    },

    async getMission(id) {
      if (!isUuid(id)) return null;
      const rows = await query<MissionRow>(
        `select ${MISSION_COLS} from drone_missions where id = $1`,
        [id],
      );
      return rows[0] ? toMission(rows[0]) : null;
    },

    async createMission(input) {
      if (!isUuid(input.incident_id)) throw new StoreNotFoundError(`incidente ${input.incident_id}`);
      try {
        // seq y label los asigna el trigger missions_assign_label (next_seq).
        const rows = await query<MissionRow>(
          `insert into drone_missions
             (incident_id, mode, pattern, radius_m, altitude_m, speed_ms, home_lat, home_lng,
              waypoints, ingest_token_hash)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
           returning ${MISSION_COLS}`,
          [
            input.incident_id,
            input.mode,
            input.pattern,
            input.radius_m,
            input.altitude_m,
            input.speed_ms,
            input.home_lat,
            input.home_lng,
            JSON.stringify(input.waypoints ?? []),
            input.ingest_token_hash,
          ],
        );
        return toMission(rows[0]);
      } catch (err) {
        rethrowNotFound(err, `incidente ${input.incident_id}`);
      }
    },

    async updateMission(id, patch) {
      if (!isUuid(id)) throw new StoreNotFoundError(`misión ${id}`);
      const values: unknown[] = [id];
      const sets = buildSets(patch, MISSION_PATCH_COLUMNS, values);
      if (sets.length === 0) sets.push("status = status");
      const rows = await query<MissionRow>(
        `update drone_missions set ${sets.join(", ")} where id = $1 returning ${MISSION_COLS}`,
        values,
      );
      if (!rows[0]) throw new StoreNotFoundError(`misión ${id}`);
      return toMission(rows[0]);
    },

    async appendTelemetry(missionId, points) {
      if (!isUuid(missionId)) throw new StoreNotFoundError(`misión ${missionId}`);
      // Sin puntos la función devuelve la misión sin tocarla (no sube rev).
      const rows = await query<MissionRow>(
        `select ${MISSION_COLS} from append_telemetry($1, $2::jsonb)`,
        [missionId, JSON.stringify(points)],
      );
      if (!rows[0]) throw new StoreNotFoundError(`misión ${missionId}`);
      return toMission(rows[0]);
    },

    async verifyIngestToken(missionId, tokenHash) {
      if (!isUuid(missionId) || typeof tokenHash !== "string" || !tokenHash) return false;
      const rows = await query<{ ingest_token_hash: string | null }>(
        "select ingest_token_hash from drone_missions where id = $1",
        [missionId],
      );
      const expected = rows[0]?.ingest_token_hash;
      return expected ? safeEqual(expected, tokenHash) : false;
    },

    /* ── Línea de tiempo ── */

    async listEvents(incidentId, limit = DEFAULT_EVENT_LIMIT) {
      if (!isUuid(incidentId)) return [];
      const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : DEFAULT_EVENT_LIMIT;
      // Más recientes primero; a igual `at`, el último insertado primero.
      const rows = await query<EventRow>(
        `select ${EVENT_COLS} from events where incident_id = $1 order by at desc, ord desc limit $2`,
        [incidentId, max],
      );
      return rows.map(toEvent);
    },

    async addEvent(input) {
      if (!isUuid(input.incident_id)) throw new StoreNotFoundError(`incidente ${input.incident_id}`);
      try {
        const rows = await query<EventRow>(
          `insert into events (incident_id, at, kind, severity, title, detail, media_id, comm_id, mission_id)
           values ($1, coalesce($2::timestamptz, now()), $3, $4, $5, $6, $7, $8, $9)
           returning ${EVENT_COLS}`,
          [
            input.incident_id,
            isoOr(input.at, null),
            input.kind,
            input.severity,
            input.title,
            input.detail,
            input.media_id ?? null,
            input.comm_id ?? null,
            input.mission_id ?? null,
          ],
        );
        return toEvent(rows[0]);
      } catch (err) {
        rethrowNotFound(err, `incidente ${input.incident_id} o referencia del evento`);
      }
    },

    /* ── Candados ── */

    async acquireLock(incidentId, name, ttlSeconds) {
      if (!isUuid(incidentId)) return false;
      const ttl = Number.isFinite(ttlSeconds) ? Math.max(0, ttlSeconds) : 0;
      const rows = await query<{ ok: boolean }>("select acquire_lock($1, $2, $3) as ok", [
        incidentId,
        name,
        ttl,
      ]);
      return rows[0]?.ok === true;
    },

    async releaseLock(incidentId, name) {
      if (!isUuid(incidentId)) return;
      await query("select release_lock($1, $2)", [incidentId, name]);
    },
  };

  return store;
}
