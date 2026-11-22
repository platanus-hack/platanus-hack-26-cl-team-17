/**
 * Vigía — contrato de persistencia.
 *
 * Implementaciones intercambiables:
 *   - PostgresStore  (producción: Cloud SQL / Postgres vía node-postgres; ./postgres.ts)
 *   - LocalStore     (desarrollo/demo sin credenciales: JSON bajo .data/; ./local.ts)
 *   - GcsFiles       (producción: Cloud Storage con URLs firmadas V4; ./gcs-files.ts)
 *   - LocalFiles     (desarrollo/demo: archivos bajo .data/files; ./local-files.ts)
 *
 * Solo código de servidor importa este módulo. Obtén la instancia con
 * `getStore()` y `getFiles()` desde "@/lib/store".
 *
 * Reglas que TODA implementación debe cumplir:
 *  - Cualquier mutación de un incidente o de sus hijos (medios, cuadros,
 *    comunicaciones, misiones, eventos) incrementa `incident.rev` y actualiza
 *    `incident.updated_at`. El sondeo del puesto de mando depende de esto.
 *  - `label` de medios ("M1", "M2"...), `label` de misiones ("D1"...) y `seq`
 *    de comunicaciones se asignan de forma atómica y secuencial por incidente.
 *  - Los métodos `get*` devuelven null si no existe; los `update*` lanzan
 *    `StoreNotFoundError`.
 *  - Fechas en ISO 8601 UTC (string).
 */
import type {
  CommEntry,
  CommSource,
  DroneMission,
  Incident,
  IncidentStatus,
  IncidentType,
  Media,
  MediaFrame,
  MissionMode,
  MissionPattern,
  TelemetryPoint,
  TimelineEvent,
} from "../domain";
import type { UploadTarget } from "../contract";

export class StoreNotFoundError extends Error {
  constructor(what: string) {
    super(`No encontrado: ${what}`);
    this.name = "StoreNotFoundError";
  }
}

export interface NewIncident {
  type: IncidentType;
  title: string;
  address: string;
  lat: number;
  lng: number;
  description: string;
  origin: Incident["origin"];
  verified: boolean;
  status?: IncidentStatus;
}

/** Campos que el servidor puede modificar en un incidente. */
export type IncidentPatch = Partial<
  Pick<
    Incident,
    | "type"
    | "title"
    | "address"
    | "lat"
    | "lng"
    | "description"
    | "status"
    | "verified"
    | "situation"
    | "situation_engine"
    | "situation_updated_at"
    | "scene"
    | "scene_engine"
    | "scene_updated_at"
    | "comms_analysis"
    | "comms_engine"
    | "comms_analysis_updated_at"
    | "reconstruction"
  >
> & {
  /** Se fusiona superficialmente con el estado actual del pipeline. */
  pipeline?: Partial<Incident["pipeline"]>;
};

export interface NewMedia {
  incident_id: string;
  source: Media["source"];
  kind: Media["kind"];
  mission_id?: string | null;
  mime?: string | null;
  size_bytes?: number | null;
  duration_s?: number | null;
  lat?: number | null;
  lng?: number | null;
  accuracy_m?: number | null;
  heading_deg?: number | null;
  captured_at?: string | null;
  reporter_note?: string;
  /** Hash SHA-256 (hex) del token de subida; null para medios creados por el servidor. */
  upload_token_hash?: string | null;
  video_status?: Media["video_status"];
  status?: Media["status"];
}

export type MediaPatch = Partial<
  Pick<
    Media,
    | "video_path"
    | "video_status"
    | "status"
    | "error"
    | "analysis"
    | "analysis_engine"
    | "analyzed_at"
    | "duration_s"
    | "mime"
    | "size_bytes"
  >
>;

export type NewFrame = Omit<MediaFrame, "id" | "media_id"> & { id?: string };

export interface NewComm {
  incident_id: string;
  text: string;
  speaker: string;
  channel: string;
  source: CommSource;
  at?: string;
  audio_path?: string | null;
}

export interface NewMission {
  incident_id: string;
  mode: MissionMode;
  pattern: MissionPattern;
  radius_m: number;
  altitude_m: number;
  speed_ms: number;
  home_lat: number;
  home_lng: number;
  waypoints: DroneMission["waypoints"];
  /** Hash SHA-256 (hex) del token de ingesta. */
  ingest_token_hash: string;
}

export type MissionPatch = Partial<
  Pick<DroneMission, "status" | "command" | "started_at" | "ended_at" | "frames_received">
>;

export type NewEvent = Omit<TimelineEvent, "id" | "at" | "media_id" | "comm_id" | "mission_id"> & {
  at?: string;
  media_id?: string | null;
  comm_id?: string | null;
  mission_id?: string | null;
};

export interface Store {
  readonly kind: "postgres" | "local";

  /* Incidentes */
  listIncidents(opts?: { status?: IncidentStatus[] }): Promise<Incident[]>;
  getIncident(id: string): Promise<Incident | null>;
  getIncidentByCode(code: string): Promise<Incident | null>;
  /** Consulta barata para el sondeo: solo el contador de revisión. */
  getIncidentRev(id: string): Promise<number | null>;
  createIncident(input: NewIncident): Promise<Incident>;
  updateIncident(id: string, patch: IncidentPatch): Promise<Incident>;
  /** Conteos para el listado del puesto de mando. */
  getIncidentCounts(
    ids: string[],
  ): Promise<Record<string, { media: number; comms: number; active_missions: number }>>;

  /* Medios */
  listMedia(incidentId: string): Promise<Media[]>;
  getMedia(id: string): Promise<Media | null>;
  createMedia(input: NewMedia): Promise<Media>;
  updateMedia(id: string, patch: MediaPatch): Promise<Media>;
  addFrames(mediaId: string, frames: NewFrame[]): Promise<MediaFrame[]>;
  /** true si `tokenHash` coincide con el token de subida del medio. */
  verifyUploadToken(mediaId: string, tokenHash: string): Promise<boolean>;
  /**
   * Lote abierto de cuadros de dron para una misión (medio source=drone,
   * kind=frames, status=uploading) o null si no hay uno abierto.
   */
  getOpenDroneBatch(missionId: string): Promise<Media | null>;

  /* Comunicaciones */
  listComms(incidentId: string): Promise<CommEntry[]>;
  addComm(input: NewComm): Promise<CommEntry>;

  /* Dron */
  listMissions(incidentId: string): Promise<DroneMission[]>;
  getMission(id: string): Promise<DroneMission | null>;
  createMission(input: NewMission): Promise<DroneMission>;
  updateMission(id: string, patch: MissionPatch): Promise<DroneMission>;
  /** Agrega puntos a la traza (acotada a los últimos 300) y actualiza `last`. */
  appendTelemetry(missionId: string, points: TelemetryPoint[]): Promise<DroneMission>;
  verifyIngestToken(missionId: string, tokenHash: string): Promise<boolean>;

  /* Línea de tiempo */
  listEvents(incidentId: string, limit?: number): Promise<TimelineEvent[]>;
  addEvent(input: NewEvent): Promise<TimelineEvent>;

  /* Exclusión mutua entre invocaciones serverless (fusión, análisis de comunicaciones) */
  /** Atómico. Devuelve true si se obtuvo el candado; expira solo tras `ttlSeconds`. */
  acquireLock(incidentId: string, name: string, ttlSeconds: number): Promise<boolean>;
  releaseLock(incidentId: string, name: string): Promise<void>;
}

/** Almacenamiento de archivos (bucket privado). Las rutas son relativas al bucket. */
export interface FileStorage {
  readonly kind: "gcs" | "local";
  /**
   * Destino para que el navegador suba directo al storage (los videos no pasan
   * por el servidor). GCS: URL firmada V4 absoluta; local: /api/local-upload firmado.
   */
  createUploadTarget(path: string, contentType: string): Promise<UploadTarget>;
  /** Subida desde el servidor (cuadros de dron, datos de demo). */
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  download(path: string): Promise<{ bytes: Uint8Array; contentType: string }>;
  exists(path: string): Promise<boolean>;
  /**
   * URL firmada de lectura de corta duración. En modo local devuelve null:
   * /api/files transmite el archivo directamente con `openLocal`.
   */
  getSignedReadUrl(path: string, ttlSeconds: number): Promise<string | null>;
  remove(paths: string[]): Promise<void>;
}

/** Convención de rutas dentro del bucket. Úsala siempre; /api/files autoriza por el prefijo. */
export const storagePaths = {
  incidentPrefix: (incidentId: string) => `incidents/${incidentId}/`,
  video: (incidentId: string, mediaId: string, ext: string) =>
    `incidents/${incidentId}/media/${mediaId}/video.${ext}`,
  frame: (incidentId: string, mediaId: string, idx: number) =>
    `incidents/${incidentId}/media/${mediaId}/frames/${String(idx).padStart(3, "0")}.jpg`,
  /** Último cuadro del video en vivo de una misión (se sobrescribe; no es evidencia). */
  live: (incidentId: string, missionId: string) => `incidents/${incidentId}/live/${missionId}.jpg`,
  /** Carpeta de una reconstrucción 3DGS (manifiesto de entrada y archivo de splats de salida). */
  reconstruction: (incidentId: string, reconstructionId: string) =>
    `incidents/${incidentId}/reconstructions/${reconstructionId}/`,
  /** Grabación de una transmisión de radio. */
  commAudio: (incidentId: string, audioId: string, ext: string) => `incidents/${incidentId}/comms/${audioId}.${ext}`,
  /** Último latido del puente Zello (fuera de incidents/: /api/files no lo sirve). */
  zelloStatus: "system/zello-status.json",
  /** Emergencia fijada en el tablero para Vigía y los puentes (fuera de incidents/: /api/files no lo sirve). */
  focus: "system/focus.json",
  /** Extrae el id de incidente de una ruta del bucket, o null si no sigue la convención. */
  incidentIdOf: (path: string): string | null => {
    const m = /^incidents\/([0-9a-fA-F-]{8,64})\//.exec(path);
    return m ? m[1] : null;
  },
} as const;
