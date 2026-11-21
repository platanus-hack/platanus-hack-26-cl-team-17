/**
 * Store del modo local (desarrollo y demo sin credenciales).
 *
 * Todo el estado vive en memoria (en globalThis, para sobrevivir al hot-reload
 * y compartirse entre los bundles de cada ruta) y se persiste como un único
 * JSON en <dataDir>/db.json. Node ejecuta cada método sin intercalar otros
 * (no hay `await` entre leer y escribir el estado), así que las secuencias
 * M<n>/D<n>/seq y el contador `rev` son atómicos dentro del proceso.
 *
 * No sirve para varias instancias a la vez: cada proceso tiene su propia copia.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "../config";
import {
  EMPTY_PIPELINE,
  type CommEntry,
  type DroneMission,
  type Incident,
  type Media,
  type MediaFrame,
  type MissionStatus,
  type PipelineState,
  type TimelineEvent,
} from "../domain";
import { newId, newIncidentCode, newToken, safeEqual } from "../ids";
import {
  StoreNotFoundError,
  type IncidentPatch,
  type MediaPatch,
  type MissionPatch,
  type Store,
} from "./types";

const DB_FILE = "db.json";
const DB_VERSION = 1;
/** Espera antes de escribir a disco: junta ráfagas (telemetría) en una sola escritura. */
const WRITE_DEBOUNCE_MS = 200;
const WRITE_RETRY_MS = 2000;
const MAX_WRITE_FAILURES = 5;
const TRACK_MAX_POINTS = 300;
const DEFAULT_EVENT_LIMIT = 200;
const ENDED_MISSION: ReadonlySet<MissionStatus> = new Set<MissionStatus>(["landed", "aborted"]);
/** Errores que no se arreglan reintentando: el directorio no es escribible. */
const READ_ONLY_CODES = new Set(["EACCES", "EPERM", "EROFS", "ENOTDIR", "EEXIST"]);

/**
 * Campos que cada `update*` puede tocar. Aunque llegue un objeto con claves de más
 * (p. ej. JSON sin validar), nunca se pisan id, code, rev, share_key ni los tokens.
 */
const INCIDENT_PATCH_KEYS = [
  "type",
  "title",
  "address",
  "lat",
  "lng",
  "description",
  "status",
  "verified",
  "situation",
  "situation_engine",
  "situation_updated_at",
  "scene",
  "scene_engine",
  "scene_updated_at",
  "comms_analysis",
  "comms_engine",
  "comms_analysis_updated_at",
] as const satisfies readonly Exclude<keyof IncidentPatch, "pipeline">[];
const PIPELINE_KEYS = Object.keys(EMPTY_PIPELINE) as (keyof PipelineState)[];
const MEDIA_PATCH_KEYS = [
  "video_path",
  "video_status",
  "status",
  "error",
  "analysis",
  "analysis_engine",
  "analyzed_at",
  "duration_s",
  "mime",
  "size_bytes",
] as const satisfies readonly (keyof MediaPatch)[];
const MISSION_PATCH_KEYS = [
  "status",
  "command",
  "started_at",
  "ended_at",
  "frames_received",
] as const satisfies readonly (keyof MissionPatch)[];

type StoredMedia = Media & { upload_token_hash: string | null };
type StoredMission = DroneMission & { ingest_token_hash: string };
interface Counters {
  media: number;
  mission: number;
  comm: number;
}

/** Estado en memoria. Se usan Map para que un id hostil ("__proto__") no toque el prototipo. */
interface Db {
  incidents: Map<string, Incident>;
  media: Map<string, StoredMedia>;
  missions: Map<string, StoredMission>;
  /** Por incidente, en orden de seq. */
  comms: Map<string, CommEntry[]>;
  /** Por incidente, en orden de inserción. */
  events: Map<string, TimelineEvent[]>;
  counters: Map<string, Counters>;
}

/** Forma del archivo db.json. */
interface DbFile {
  version: number;
  saved_at: string;
  incidents: Incident[];
  media: StoredMedia[];
  missions: StoredMission[];
  comms: CommEntry[];
  events: TimelineEvent[];
  counters: ({ incident_id: string } & Counters)[];
}

interface Holder {
  dir: string;
  file: string;
  db: Db | null;
  /** Candados en memoria: clave → instante de expiración (ms). */
  locks: Map<string, number>;
  dirty: boolean;
  /** Hay una escritura asíncrona en curso (si el proceso termina ahora, hay que repetirla). */
  writing: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  chain: Promise<void>;
  persist: boolean;
  warned: boolean;
  failures: number;
  tmpSeq: number;
}

type GlobalWithLocalStore = typeof globalThis & {
  __vigiaLocalStore?: Map<string, Holder>;
  __vigiaLocalStoreExitHook?: boolean;
};

function registry(): Map<string, Holder> {
  const g = globalThis as GlobalWithLocalStore;
  if (!g.__vigiaLocalStore) g.__vigiaLocalStore = new Map();
  if (!g.__vigiaLocalStoreExitHook) {
    g.__vigiaLocalStoreExitHook = true;
    // Última oportunidad si el proceso termina con una escritura pendiente del debounce.
    process.once("exit", () => {
      const holders = (globalThis as GlobalWithLocalStore).__vigiaLocalStore;
      if (holders) for (const h of holders.values()) writeSync(h);
    });
  }
  return g.__vigiaLocalStore;
}

function holderFor(dir: string): Holder {
  const reg = registry();
  let h = reg.get(dir);
  if (!h) {
    h = {
      dir,
      file: path.join(dir, DB_FILE),
      db: null,
      locks: new Map(),
      dirty: false,
      writing: false,
      timer: null,
      chain: Promise.resolve(),
      persist: true,
      warned: false,
      failures: 0,
      tmpSeq: 0,
    };
    reg.set(dir, h);
  }
  return h;
}

function errnoCode(err: unknown): string {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code: unknown }).code)
    : "";
}

function warnOnce(h: Holder, message: string, err?: unknown): void {
  if (h.warned) return;
  h.warned = true;
  const reason = err instanceof Error ? ` (${err.message})` : "";
  console.warn(`[vigia:local-store] ${message}${reason}`);
}

/* ───────────────────────── Carga y normalización ───────────────────────── */

function emptyDb(): Db {
  return {
    incidents: new Map(),
    media: new Map(),
    missions: new Map(),
    comms: new Map(),
    events: new Map(),
    counters: new Map(),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function rowsOf<T>(value: unknown, isValid: (row: Record<string, unknown>) => boolean): T[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is T => isRecord(row) && isValid(row));
}

const hasId = (r: Record<string, unknown>) => typeof r.id === "string";
const hasIncident = (r: Record<string, unknown>) => hasId(r) && typeof r.incident_id === "string";

function labelNumber(label: string): number {
  const n = Number.parseInt(label.slice(1), 10);
  return Number.isFinite(n) ? n : 0;
}

function ms(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/** Tolera archivos escritos por versiones anteriores o editados a mano. */
function fromFile(raw: unknown): Db {
  if (!isRecord(raw)) throw new Error("db.json no contiene un objeto");
  const db = emptyDb();

  for (const inc of rowsOf<Incident>(raw.incidents, hasId)) {
    inc.pipeline = { ...EMPTY_PIPELINE, ...(isRecord(inc.pipeline) ? inc.pipeline : {}) };
    if (!Number.isFinite(inc.rev)) inc.rev = 1;
    db.incidents.set(inc.id, inc);
    db.comms.set(inc.id, []);
    db.events.set(inc.id, []);
    db.counters.set(inc.id, { media: 0, mission: 0, comm: 0 });
  }
  for (const m of rowsOf<StoredMedia>(raw.media, hasIncident)) {
    if (!db.incidents.has(m.incident_id)) continue;
    m.frames = Array.isArray(m.frames) ? m.frames : [];
    m.upload_token_hash = typeof m.upload_token_hash === "string" ? m.upload_token_hash : null;
    db.media.set(m.id, m);
  }
  for (const m of rowsOf<StoredMission>(raw.missions, hasIncident)) {
    if (!db.incidents.has(m.incident_id)) continue;
    m.track = Array.isArray(m.track) ? m.track : [];
    m.ingest_token_hash = typeof m.ingest_token_hash === "string" ? m.ingest_token_hash : "";
    db.missions.set(m.id, m);
  }
  for (const c of rowsOf<CommEntry>(raw.comms, hasIncident)) db.comms.get(c.incident_id)?.push(c);
  for (const list of db.comms.values()) list.sort((a, b) => a.seq - b.seq);
  for (const e of rowsOf<TimelineEvent>(raw.events, hasIncident)) {
    db.events.get(e.incident_id)?.push(e);
  }

  // Los contadores nunca retroceden: se toma el mayor entre lo guardado y lo que ya existe.
  const saved = new Map<string, Record<string, unknown>>();
  if (Array.isArray(raw.counters)) {
    for (const c of raw.counters) {
      if (isRecord(c) && typeof c.incident_id === "string") saved.set(c.incident_id, c);
    }
  }
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  for (const [id, counters] of db.counters) {
    const s = saved.get(id);
    counters.media = num(s?.media);
    counters.mission = num(s?.mission);
    counters.comm = num(s?.comm);
    for (const c of db.comms.get(id) ?? []) counters.comm = Math.max(counters.comm, c.seq);
  }
  for (const m of db.media.values()) {
    const c = db.counters.get(m.incident_id);
    if (c) c.media = Math.max(c.media, labelNumber(m.label));
  }
  for (const m of db.missions.values()) {
    const c = db.counters.get(m.incident_id);
    if (c) c.mission = Math.max(c.mission, labelNumber(m.label));
  }
  return db;
}

function toFile(db: Db): DbFile {
  return {
    version: DB_VERSION,
    saved_at: new Date().toISOString(),
    incidents: [...db.incidents.values()],
    media: [...db.media.values()],
    missions: [...db.missions.values()],
    comms: [...db.comms.values()].flat(),
    events: [...db.events.values()].flat(),
    counters: [...db.counters].map(([incident_id, c]) => ({ incident_id, ...c })),
  };
}

function load(h: Holder): Db {
  if (h.db) return h.db;
  let db = emptyDb();
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(h.file, "utf8");
  } catch (err) {
    if (errnoCode(err) !== "ENOENT") {
      // No se pudo leer lo que hay: no se escribe encima para no destruirlo.
      h.persist = false;
      warnOnce(h, `No se pudo leer ${h.file}; se trabajará solo en memoria.`, err);
    }
  }
  if (raw !== null) {
    try {
      db = fromFile(JSON.parse(raw));
    } catch (err) {
      const backup = `${h.file}.corrupto-${Date.now()}`;
      try {
        fs.renameSync(h.file, backup);
        console.warn(
          `[vigia:local-store] ${h.file} estaba dañado; se respaldó en ${backup} y se parte de cero.`,
        );
      } catch {
        h.persist = false;
        warnOnce(h, `${h.file} está dañado y no se pudo respaldar; se trabajará solo en memoria.`, err);
      }
    }
  }
  h.db = db;
  return db;
}

/* ───────────────────────────── Persistencia ───────────────────────────── */

function schedule(h: Holder, delayMs: number): void {
  if (h.timer || !h.persist) return;
  h.timer = setTimeout(() => {
    h.timer = null;
    void flush(h);
  }, delayMs);
}

function markDirty(h: Holder): void {
  h.dirty = true;
  schedule(h, WRITE_DEBOUNCE_MS);
}

/** Encola una escritura; las escrituras nunca se solapan. */
function flush(h: Holder): Promise<void> {
  if (h.timer) {
    clearTimeout(h.timer);
    h.timer = null;
  }
  h.chain = h.chain.then(() => writeNow(h));
  return h.chain;
}

function onWriteFailure(h: Holder, err: unknown): void {
  h.failures += 1;
  h.dirty = true;
  if (READ_ONLY_CODES.has(errnoCode(err)) || h.failures >= MAX_WRITE_FAILURES) {
    h.persist = false;
    warnOnce(
      h,
      `No se puede escribir en ${h.dir}; los datos quedarán solo en memoria y se perderán al reiniciar.`,
      err,
    );
    return;
  }
  schedule(h, WRITE_RETRY_MS);
}

async function writeNow(h: Holder): Promise<void> {
  if (!h.dirty || !h.persist || !h.db) return;
  h.dirty = false;
  h.writing = true;
  const tmp = `${h.file}.${process.pid}.${++h.tmpSeq}.tmp`;
  try {
    const json = JSON.stringify(toFile(h.db));
    await fsp.mkdir(h.dir, { recursive: true });
    await fsp.writeFile(tmp, json, "utf8");
    // rename es atómico: un lector nunca ve un db.json a medio escribir.
    await fsp.rename(tmp, h.file);
    h.failures = 0;
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    onWriteFailure(h, err);
  } finally {
    h.writing = false;
  }
}

function writeSync(h: Holder): void {
  if (!(h.dirty || h.writing) || !h.persist || !h.db) return;
  const tmp = `${h.file}.${process.pid}.exit.tmp`;
  try {
    fs.mkdirSync(h.dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(toFile(h.db)), "utf8");
    fs.renameSync(tmp, h.file);
    h.dirty = false;
  } catch {
    // El proceso ya está terminando; no queda nada más que hacer.
  }
}

/** Escribe ya lo pendiente (scripts y pruebas). */
export async function flushLocalStore(): Promise<void> {
  await Promise.all([...registry().values()].map((h) => flush(h)));
}

/**
 * Escribe lo pendiente y descarta el estado en memoria (datos y candados): la
 * próxima operación vuelve a leer db.json. Solo para pruebas; simula reiniciar el proceso.
 */
export async function resetLocalStoreCache(): Promise<void> {
  await flushLocalStore();
  for (const h of registry().values()) {
    h.db = null;
    h.locks.clear();
  }
}

/* ─────────────────────────────── Utilidades ─────────────────────────────── */

function clone<T>(value: T): T {
  return structuredClone(value);
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Normaliza una fecha de entrada a ISO UTC; si no es válida usa `fallback`. */
function isoOr(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const t = Date.parse(value);
  return Number.isNaN(t) ? fallback : new Date(t).toISOString();
}

/** Copia a `target` los campos permitidos del parche que vengan definidos. */
function applyPatch<T extends object, K extends keyof T>(
  target: T,
  patch: Partial<Pick<T, K>>,
  keys: readonly K[],
): void {
  for (const key of keys) {
    const value = patch[key];
    if (value !== undefined) target[key] = clone(value) as T[K];
  }
}

function toMedia(stored: StoredMedia): Media {
  const copy: Media & { upload_token_hash?: string | null } = clone(stored);
  delete copy.upload_token_hash;
  copy.frames.sort((a, b) => a.idx - b.idx);
  return copy;
}

function toMission(stored: StoredMission): DroneMission {
  const copy: DroneMission & { ingest_token_hash?: string } = clone(stored);
  delete copy.ingest_token_hash;
  return copy;
}

/* ───────────────────────────────── Store ───────────────────────────────── */

export function createLocalStore(): Store {
  const h = holderFor(path.resolve(config.localDataDir));

  const requireIncident = (db: Db, id: string): Incident => {
    const inc = db.incidents.get(id);
    if (!inc) throw new StoreNotFoundError(`incidente ${id}`);
    return inc;
  };

  /** Toda mutación de un incidente o de sus hijos pasa por aquí. */
  const touch = (db: Db, incidentId: string, at: string): void => {
    const inc = requireIncident(db, incidentId);
    inc.rev += 1;
    inc.updated_at = at;
    markDirty(h);
  };

  const counters = (db: Db, incidentId: string): Counters => {
    let c = db.counters.get(incidentId);
    if (!c) {
      c = { media: 0, mission: 0, comm: 0 };
      db.counters.set(incidentId, c);
    }
    return c;
  };

  const store: Store = {
    kind: "local",

    /* ── Incidentes ── */

    async listIncidents(opts) {
      const db = load(h);
      // Una lista vacía se trata como "sin filtro": mejor mostrar de más que ocultar incidentes.
      const wanted = opts?.status?.length ? new Set(opts.status) : null;
      return [...db.incidents.values()]
        .filter((i) => !wanted || wanted.has(i.status))
        .reverse()
        .sort((a, b) => ms(b.created_at) - ms(a.created_at))
        .map(clone);
    },

    async getIncident(id) {
      const inc = load(h).incidents.get(id);
      return inc ? clone(inc) : null;
    },

    async getIncidentByCode(code) {
      const wanted = code.trim().toUpperCase();
      for (const inc of load(h).incidents.values()) {
        if (inc.code === wanted) return clone(inc);
      }
      return null;
    },

    async getIncidentRev(id) {
      return load(h).incidents.get(id)?.rev ?? null;
    },

    async createIncident(input) {
      const db = load(h);
      const taken = new Set([...db.incidents.values()].map((i) => i.code));
      let code = newIncidentCode();
      for (let tries = 0; taken.has(code); tries++) {
        if (tries >= 200) throw new Error("No se pudo generar un código de incidente único.");
        code = newIncidentCode();
      }
      const at = nowIso();
      const incident: Incident = {
        id: newId(),
        code,
        type: input.type,
        title: input.title,
        address: input.address,
        lat: input.lat,
        lng: input.lng,
        status: input.status ?? "active",
        description: input.description,
        origin: input.origin,
        verified: input.verified,
        share_key: newToken(),
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
        pipeline: { ...EMPTY_PIPELINE },
        created_at: at,
        updated_at: at,
      };
      db.incidents.set(incident.id, incident);
      db.comms.set(incident.id, []);
      db.events.set(incident.id, []);
      db.counters.set(incident.id, { media: 0, mission: 0, comm: 0 });
      markDirty(h);
      return clone(incident);
    },

    async updateIncident(id, patch) {
      const db = load(h);
      const inc = requireIncident(db, id);
      applyPatch(inc, patch, INCIDENT_PATCH_KEYS);
      if (patch.pipeline) applyPatch(inc.pipeline, patch.pipeline, PIPELINE_KEYS);
      touch(db, id, nowIso());
      return clone(inc);
    },

    async getIncidentCounts(ids) {
      const db = load(h);
      const out = new Map<string, { media: number; comms: number; active_missions: number }>();
      for (const id of ids) {
        out.set(id, { media: 0, comms: db.comms.get(id)?.length ?? 0, active_missions: 0 });
      }
      for (const m of db.media.values()) {
        const c = out.get(m.incident_id);
        if (c) c.media += 1;
      }
      for (const m of db.missions.values()) {
        const c = out.get(m.incident_id);
        if (c && !ENDED_MISSION.has(m.status)) c.active_missions += 1;
      }
      return Object.fromEntries(out);
    },

    /* ── Medios ── */

    async listMedia(incidentId) {
      const db = load(h);
      return [...db.media.values()]
        .filter((m) => m.incident_id === incidentId)
        .sort(
          (a, b) =>
            ms(a.created_at) - ms(b.created_at) || labelNumber(a.label) - labelNumber(b.label),
        )
        .map(toMedia);
    },

    async getMedia(id) {
      const m = load(h).media.get(id);
      return m ? toMedia(m) : null;
    },

    async createMedia(input) {
      const db = load(h);
      requireIncident(db, input.incident_id);
      const at = nowIso();
      const n = ++counters(db, input.incident_id).media;
      const media: StoredMedia = {
        id: newId(),
        incident_id: input.incident_id,
        label: `M${n}`,
        source: input.source,
        kind: input.kind,
        mission_id: input.mission_id ?? null,
        video_path: null,
        video_status: input.video_status ?? "none",
        mime: input.mime ?? null,
        size_bytes: input.size_bytes ?? null,
        duration_s: input.duration_s ?? null,
        lat: input.lat ?? null,
        lng: input.lng ?? null,
        accuracy_m: input.accuracy_m ?? null,
        heading_deg: input.heading_deg ?? null,
        captured_at: input.captured_at ?? null,
        reporter_note: input.reporter_note ?? "",
        status: input.status ?? "uploading",
        error: null,
        analysis: null,
        analysis_engine: null,
        analyzed_at: null,
        frames: [],
        created_at: at,
        upload_token_hash: input.upload_token_hash ?? null,
      };
      db.media.set(media.id, media);
      touch(db, media.incident_id, at);
      return toMedia(media);
    },

    async updateMedia(id, patch) {
      const db = load(h);
      const media = db.media.get(id);
      if (!media) throw new StoreNotFoundError(`medio ${id}`);
      applyPatch<Media, keyof MediaPatch>(media, patch, MEDIA_PATCH_KEYS);
      touch(db, media.incident_id, nowIso());
      return toMedia(media);
    },

    async addFrames(mediaId, frames) {
      const db = load(h);
      const media = db.media.get(mediaId);
      if (!media) throw new StoreNotFoundError(`medio ${mediaId}`);
      const added: MediaFrame[] = [];
      for (const f of frames) {
        // Reintentar la subida de un mismo índice reemplaza el cuadro en vez de duplicarlo.
        const at = media.frames.findIndex((x) => x.idx === f.idx);
        const frame: MediaFrame = {
          id: f.id ?? (at >= 0 ? media.frames[at].id : newId()),
          media_id: mediaId,
          idx: f.idx,
          t_s: f.t_s,
          storage_path: f.storage_path,
          width: f.width,
          height: f.height,
          lat: f.lat ?? null,
          lng: f.lng ?? null,
          alt_m: f.alt_m ?? null,
          heading_deg: f.heading_deg ?? null,
        };
        if (at >= 0) media.frames[at] = frame;
        else media.frames.push(frame);
        added.push(frame);
      }
      if (added.length > 0) {
        media.frames.sort((a, b) => a.idx - b.idx);
        touch(db, media.incident_id, nowIso());
      }
      return clone(added);
    },

    async verifyUploadToken(mediaId, tokenHash) {
      const expected = load(h).media.get(mediaId)?.upload_token_hash;
      if (!expected || typeof tokenHash !== "string" || !tokenHash) return false;
      return safeEqual(expected, tokenHash);
    },

    async getOpenDroneBatch(missionId) {
      let open: StoredMedia | null = null;
      for (const m of load(h).media.values()) {
        if (
          m.mission_id === missionId &&
          m.source === "drone" &&
          m.kind === "frames" &&
          m.status === "uploading"
        ) {
          // Si quedara más de uno abierto, vale el más reciente.
          if (!open || labelNumber(m.label) > labelNumber(open.label)) open = m;
        }
      }
      return open ? toMedia(open) : null;
    },

    /* ── Comunicaciones ── */

    async listComms(incidentId) {
      const list = load(h).comms.get(incidentId) ?? [];
      return [...list].sort((a, b) => a.seq - b.seq).map(clone);
    },

    async addComm(input) {
      const db = load(h);
      requireIncident(db, input.incident_id);
      const at = nowIso();
      const entry: CommEntry = {
        id: newId(),
        incident_id: input.incident_id,
        seq: ++counters(db, input.incident_id).comm,
        at: isoOr(input.at, at),
        channel: input.channel,
        speaker: input.speaker,
        text: input.text,
        source: input.source,
        created_at: at,
      };
      const list = db.comms.get(entry.incident_id);
      if (list) list.push(entry);
      else db.comms.set(entry.incident_id, [entry]);
      touch(db, entry.incident_id, at);
      return clone(entry);
    },

    /* ── Dron ── */

    async listMissions(incidentId) {
      const db = load(h);
      return [...db.missions.values()]
        .filter((m) => m.incident_id === incidentId)
        .sort(
          (a, b) =>
            ms(a.created_at) - ms(b.created_at) || labelNumber(a.label) - labelNumber(b.label),
        )
        .map(toMission);
    },

    async getMission(id) {
      const m = load(h).missions.get(id);
      return m ? toMission(m) : null;
    },

    async createMission(input) {
      const db = load(h);
      requireIncident(db, input.incident_id);
      const at = nowIso();
      const n = ++counters(db, input.incident_id).mission;
      const mission: StoredMission = {
        id: newId(),
        incident_id: input.incident_id,
        label: `D${n}`,
        status: "planned",
        mode: input.mode,
        pattern: input.pattern,
        radius_m: input.radius_m,
        altitude_m: input.altitude_m,
        speed_ms: input.speed_ms,
        home_lat: input.home_lat,
        home_lng: input.home_lng,
        waypoints: clone(input.waypoints),
        command: "continue",
        last: null,
        track: [],
        frames_received: 0,
        created_at: at,
        started_at: null,
        ended_at: null,
        ingest_token_hash: input.ingest_token_hash,
      };
      db.missions.set(mission.id, mission);
      touch(db, mission.incident_id, at);
      return toMission(mission);
    },

    async updateMission(id, patch) {
      const db = load(h);
      const mission = db.missions.get(id);
      if (!mission) throw new StoreNotFoundError(`misión ${id}`);
      applyPatch<DroneMission, keyof MissionPatch>(mission, patch, MISSION_PATCH_KEYS);
      touch(db, mission.incident_id, nowIso());
      return toMission(mission);
    },

    async appendTelemetry(missionId, points) {
      const db = load(h);
      const mission = db.missions.get(missionId);
      if (!mission) throw new StoreNotFoundError(`misión ${missionId}`);
      if (points.length > 0) {
        mission.track = mission.track.concat(clone(points)).slice(-TRACK_MAX_POINTS);
        mission.last = clone(points[points.length - 1]);
        touch(db, mission.incident_id, nowIso());
      }
      return toMission(mission);
    },

    async verifyIngestToken(missionId, tokenHash) {
      const expected = load(h).missions.get(missionId)?.ingest_token_hash;
      if (!expected || typeof tokenHash !== "string" || !tokenHash) return false;
      return safeEqual(expected, tokenHash);
    },

    /* ── Línea de tiempo ── */

    async listEvents(incidentId, limit = DEFAULT_EVENT_LIMIT) {
      const list = load(h).events.get(incidentId) ?? [];
      const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : DEFAULT_EVENT_LIMIT;
      return list
        .map((event, order) => ({ event, order, t: ms(event.at) }))
        .sort((a, b) => b.t - a.t || b.order - a.order)
        .slice(0, max)
        .map((x) => clone(x.event));
    },

    async addEvent(input) {
      const db = load(h);
      requireIncident(db, input.incident_id);
      const at = nowIso();
      const event: TimelineEvent = {
        id: newId(),
        incident_id: input.incident_id,
        at: isoOr(input.at, at),
        kind: input.kind,
        severity: input.severity,
        title: input.title,
        detail: input.detail,
        media_id: input.media_id ?? null,
        comm_id: input.comm_id ?? null,
        mission_id: input.mission_id ?? null,
      };
      const list = db.events.get(event.incident_id);
      if (list) list.push(event);
      else db.events.set(event.incident_id, [event]);
      touch(db, event.incident_id, at);
      return clone(event);
    },

    /* ── Candados ── */

    async acquireLock(incidentId, name, ttlSeconds) {
      const key = `${incidentId}\n${name}`;
      const now = Date.now();
      const expiresAt = h.locks.get(key);
      if (expiresAt !== undefined && expiresAt > now) return false;
      if (h.locks.size > 500) {
        for (const [k, exp] of h.locks) if (exp <= now) h.locks.delete(k);
      }
      const ttlMs = Number.isFinite(ttlSeconds) ? Math.max(0, ttlSeconds) * 1000 : 0;
      h.locks.set(key, now + ttlMs);
      return true;
    },

    async releaseLock(incidentId, name) {
      h.locks.delete(`${incidentId}\n${name}`);
    },
  };

  return store;
}
