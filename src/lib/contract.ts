/**
 * Vigía — contrato HTTP entre el navegador (o el dron) y las rutas /api.
 *
 * Todas las respuestas de error usan `ApiError` con el status HTTP adecuado.
 * Las rutas "staff" exigen sesión de personal cuando hay Postgres configurado
 * (mode.auth === "staff"); en modo local quedan abiertas y la UI muestra "MODO LOCAL".
 *
 * Mapa de rutas
 * ─────────────
 * Staff (puesto de mando)
 *   GET    /api/incidents                      → IncidentListResponse
 *   POST   /api/incidents                      CreateIncidentInput → { incident }
 *   GET    /api/incidents/[id]?rev=N           → IncidentSnapshot | UnchangedResponse
 *   PATCH  /api/incidents/[id]                 UpdateIncidentInput → { incident }
 *   POST   /api/incidents/[id]/analyze         AnalyzeRequest → { ok: true }
 *   POST   /api/incidents/[id]/media/[mediaId]/frames   StaffFramesRequest → StaffFramesResponse
 *          (el mando extrae fotogramas en su navegador para un medio que llegó sin ellos; registra
 *           los cuadros y devuelve destinos de subida; luego se llama a /analyze con media_id)
 *   POST   /api/incidents/[id]/comms           AddCommInput → { entry }
 *   POST   /api/incidents/[id]/comms/audio     audio crudo (webm/ogg/mp4/mp3, ≤ 4 MB) → { audio_path }
 *          (grabación de una transmisión; luego se registra la entrada con ese audio_path)
 *   POST   /api/incidents/[id]/reconstruction  StartReconstructionInput → { reconstruction }
 *          (lanza la reconstrucción 3D Gaussian Splatting en el job de GPU; 409 si ya hay una en curso
 *           o si no hay GPU configurada; el progreso llega en incident.reconstruction del snapshot)
 *   POST   /api/incidents/[id]/missions        CreateMissionInput → CreateMissionResponse
 *   PATCH  /api/missions/[id]                  MissionCommandRequest → { mission }
 *   POST   /api/missions/[id]/tick             (solo misiones simuladas) → { mission }
 *   POST   /api/demo/seed                      → { incident_id }
 *   POST   /api/demo/scenario                  ScenarioStepRequest → ScenarioStepResponse
 *
 * Público (vecinos, sin sesión)
 *   GET    /api/public/incidents?lat=&lng=     → PublicIncidentListResponse
 *   GET    /api/public/incidents/[code]        → { incident: PublicIncident }
 *   POST   /api/public/reports                 CreateReportInput → CreateReportResponse
 *   POST   /api/public/reports/[mediaId]/complete   CompleteReportRequest (header x-upload-token) → { ok: true }
 *
 * Briefing en ruta (enlace con clave de solo lectura)
 *   GET    /api/briefing/[id]?k=<share_key>&rev=N   → BriefingSnapshot | UnchangedResponse
 *
 * Dron (Authorization: Bearer <ingest_token>)
 *   POST   /api/drone/[missionId]/telemetry    TelemetryInput → TelemetryResponse
 *   POST   /api/drone/[missionId]/frame?lat=&lng=&alt=&heading=&t=&flush=0|1
 *          body = image/jpeg crudo (≤ 3 MB)  → DroneFrameResponse
 *   POST   /api/drone/[missionId]/live         body = image/jpeg chico (video en vivo, sin guardar) → LiveFrameAck
 *
 * Puente Zello (Authorization: Bearer <VIGIA_BRIDGE_TOKEN>; en modo local abierto no hace falta)
 *   POST   /api/incidents/[id]/comms (source "zello") y …/comms/audio, GET /api/incidents: igual que el mando
 *   POST   /api/incidents/[id]/ask            { question } → { answer, focus, engine }   (respaldo mientras
 *          no exista la salida del agente; la misma ruta la usa la ficha del mando)
 *   POST   /api/zello/status                   ZelloBridgeStatus → { ok: true }   (latido cada ~10 s)
 *   GET    /api/zello/status                   (staff) → ZelloStatusResponse
 *
 * Job de GPU (Authorization: Bearer <token de la reconstrucción, HMAC del servidor>)
 *   POST   /api/internal/reconstruction/[incidentId]   ReconstructionUpdate → { ok: true, cancel: boolean }
 *
 * Archivos
 *   GET    /api/files/<storage_path>[?k=<share_key>]   → 302 a URL firmada (Cloud Storage) o stream con Range (local)
 *   PUT    /api/local-upload/<storage_path>?exp=&sig=  (solo modo local; destino de UploadTarget)
 *
 * Personal (sesión con cookie firmada; solo cuando mode.auth === "staff")
 *   POST   /api/auth/login                     LoginRequest → { staff: StaffPublic }
 *   POST   /api/auth/logout                    → { ok: true }
 *   GET    /api/auth/me                        → { staff: StaffPublic | null, mode: RuntimeMode }
 *   GET    /api/staff                          (admin) → { staff: StaffPublic[] }
 *   POST   /api/staff                          (admin) CreateStaffRequest → { staff: StaffPublic }
 *
 * Estado
 *   GET    /api/status                         → { mode: RuntimeMode }
 */
import type {
  CommEntry,
  DroneMission,
  Incident,
  IncidentStatus,
  IncidentType,
  Media,
  SceneModel,
  SituationReport,
  TimelineEvent,
  TimelineSeverity,
  TrappedStatus,
  Severity,
  AnalysisEngine,
  Confidence,
} from "./domain";

export interface ApiError {
  error: string;
  /** Código estable para la UI: "unauthorized" | "forbidden" | "not_found" | "invalid" | "too_large" | "rate_limited" | "conflict" | "internal" */
  code: string;
  details?: unknown;
}

/** Cómo está corriendo esta instancia. La UI lo muestra de forma permanente. */
export interface RuntimeMode {
  /** postgres = Cloud SQL / Postgres real; local = JSON en .data/ (desarrollo y demo). */
  store: "postgres" | "local";
  /** gcs = Cloud Storage con URLs firmadas; local = .data/files. */
  files: "gcs" | "local";
  /** claude = análisis real con visión; simulated = sin ANTHROPIC_API_KEY, resultados de demostración. */
  ai: AnalysisEngine;
  /** staff = requiere inicio de sesión del personal; open = sin autenticación (solo demo/local). */
  auth: "staff" | "open";
  model: string | null;
  /** cloud_run_gpu = hay job de GPU configurado para 3D Gaussian Splatting; off = no disponible. */
  splat?: "cloud_run_gpu" | "off";
  /** true = radio de demostración sin sesión activa en /radio/<código> (VIGIA_DEMO_RADIO). */
  demo_radio?: boolean;
}

/* ───────────── Personal ───────────── */

export type StaffRole = "admin" | "officer" | "operator";

export interface StaffPublic {
  id: string;
  email: string;
  name: string;
  role: StaffRole;
  /** true en modo abierto (sin base de datos): sesión de demostración. */
  demo: boolean;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface CreateStaffRequest {
  email: string;
  name: string;
  role: StaffRole;
  /** Contraseña inicial (mín. 10 caracteres). */
  password: string;
}

/* ───────────── Staff ───────────── */

export interface IncidentSummary {
  id: string;
  code: string;
  type: IncidentType;
  title: string;
  address: string;
  lat: number;
  lng: number;
  status: IncidentStatus;
  origin: Incident["origin"];
  verified: boolean;
  created_at: string;
  updated_at: string;
  rev: number;
  headline: string | null;
  severity: Severity | null;
  trapped_status: TrappedStatus | null;
  /** Motor que produjo el informe (null sin informe). Opcional: la UI rotula "Simulado" si es simulated. */
  situation_engine?: AnalysisEngine | null;
  /** Confianza global del informe (`overall_confidence`; null sin informe). Opcional. */
  situation_confidence?: Confidence | null;
  media_count: number;
  comms_count: number;
  active_missions: number;
}

export interface IncidentListResponse {
  incidents: IncidentSummary[];
  mode: RuntimeMode;
}

/** URLs estables servidas por /api/files (no cambian entre sondeos, así el navegador las cachea). */
export interface MediaUrls {
  video: string | null;
  poster: string | null;
  frames: { idx: number; t_s: number; url: string; width: number; height: number }[];
}

export type MediaView = Media & { urls: MediaUrls };

export interface IncidentSnapshot {
  unchanged?: false;
  incident: Incident;
  media: MediaView[];
  comms: CommEntry[];
  missions: DroneMission[];
  /** Más recientes primero, máx. 200. */
  events: TimelineEvent[];
  mode: RuntimeMode;
  server_time: string;
  /** Rutas relativas para compartir: vecinos y unidades en ruta. */
  share: { report_path: string; briefing_path: string };
}

export interface UnchangedResponse {
  unchanged: true;
  rev: number;
  server_time: string;
}

export interface AnalyzeRequest {
  /** Si viene, reanaliza solo ese medio y luego refusiona; si no, fuerza la fusión completa. */
  media_id?: string;
  /** Reanalizar comunicaciones. */
  comms?: boolean;
}

export interface StaffFramesRequest {
  frames: { idx: number; t_s: number; width: number; height: number }[];
}

export interface StaffFramesResponse {
  /** Un destino por fotograma, en el mismo orden que la solicitud. */
  frame_uploads: UploadTarget[];
}

export interface CreateMissionResponse {
  mission: DroneMission;
  /** Token de ingesta: se entrega una sola vez. Va en el enlace del modo sensor y en el puente del dron. */
  ingest_token: string;
  /** Ruta relativa de la página "modo sensor" lista para abrir en el teléfono del dron. */
  sensor_path: string;
}

export interface MissionCommandRequest {
  action: "recall" | "abort" | "resume";
}

export interface ScenarioStepRequest {
  /** null para iniciar un simulacro nuevo (el paso 0 crea el incidente); luego el id devuelto. */
  incident_id: string | null;
  /** Paso a ejecutar (0..n-1). El cliente avanza el guion con un temporizador. */
  step: number;
}

export interface ScenarioStepResponse {
  /** Incidente del simulacro (creado en el paso 0). */
  incident_id: string;
  done: boolean;
  next_step: number;
  /** Segundos que el cliente debe esperar antes del siguiente paso. */
  wait_s: number;
  label: string;
  total_steps: number;
}

/* ───────────── Público (vecinos) ───────────── */

export interface PublicIncident {
  code: string;
  type: IncidentType;
  title: string;
  address: string;
  /** Coordenadas redondeadas (~100 m) — no se expone la ubicación exacta. */
  lat: number;
  lng: number;
  distance_m: number | null;
  created_at: string;
}

export interface PublicIncidentListResponse {
  incidents: PublicIncident[];
}

export interface UploadTarget {
  method: "PUT";
  url: string;
  headers: Record<string, string>;
}

/**
 * Nota sobre POST /api/public/reports: si la solicitud trae `as_responder: true`
 * y quien llama tiene sesión de personal, el medio se registra con
 * source = "responder" (video recibido por el mando, p. ej. por WhatsApp).
 * Para cualquier otro caso el medio es source = "citizen".
 */
export interface CreateReportResponse {
  media_id: string;
  incident_code: string;
  /** true si el reporte creó un incidente nuevo (sin verificar). */
  created_incident: boolean;
  /** Secreto de un solo uso para /complete (header x-upload-token). */
  upload_token: string;
  /** Un destino por fotograma, en el mismo orden que `frames` de la solicitud. */
  frame_uploads: UploadTarget[];
  video_upload: UploadTarget | null;
}

export interface CompleteReportRequest {
  /** frames: ya subieron los fotogramas → se dispara el análisis. video: terminó (o falló) el video original. */
  part: "frames" | "video";
  ok: boolean;
  error?: string;
}

/* ───────────── Briefing en ruta ───────────── */

export interface BriefingSnapshot {
  unchanged?: false;
  incident: Pick<
    Incident,
    | "id"
    | "code"
    | "type"
    | "title"
    | "address"
    | "lat"
    | "lng"
    | "status"
    | "verified"
    | "rev"
    | "created_at"
    | "situation_updated_at"
    | "situation_engine"
    | "scene_engine"
  >;
  situation: SituationReport | null;
  scene: SceneModel | null;
  /** Fotogramas clave ya resueltos (máx. 6) para mostrar en la tablet del carro. */
  key_frames: { media_label: string; frame: number; url: string; caption: string }[];
  media_count: number;
  mode: RuntimeMode;
  server_time: string;
}

/* ───────────── Dron ───────────── */

export interface TelemetryResponse {
  ok: true;
  /** Orden pendiente del puesto de mando; el dron debe obedecer `recall` y `abort`. */
  command: DroneMission["command"];
  status: DroneMission["status"];
}

export interface DroneFrameResponse {
  ok: true;
  media_id: string;
  frame_idx: number;
  /** true si este cuadro cerró el lote y se envió a análisis. */
  flushed: boolean;
  command: DroneMission["command"];
}

/** Respuesta a un cuadro del video en vivo. */
export interface LiveFrameAck {
  ok: true;
  seq: number;
  command: DroneMission["command"];
}

/** Observación del video en vivo del dron (cada ~15 s, en memoria del servidor). */
export interface LiveInsightView {
  id: string;
  at: string;
  summary: string;
  severity: TimelineSeverity;
  changed: boolean;
  observations: string[];
  /** "simulated" = sin IA real; "error" = la ventana no se pudo analizar. */
  engine: "claude" | "simulated" | "error";
  /** Cuadros que miró el observador. */
  frames: number;
}

/**
 * Personal:
 *   GET /api/drone/[missionId]/live?after=<seq>  → image/jpeg (X-Live-Seq, X-Live-At) · 204 sin cuadro nuevo · 404 sin video
 *   GET /api/drone/[missionId]/live/insights     → LiveInsightsResponse
 */
export interface LiveInsightsResponse {
  insights: LiveInsightView[];
  analyzing: boolean;
  every_s: number;
}

/* ───────────── Reconstrucción 3DGS: manifiesto para el job de GPU ───────────── */

/**
 * JSON que el servidor escribe en storagePaths.reconstruction(...) + "manifest.json"
 * y que el job de GPU lee para saber qué procesar. Rutas relativas al bucket.
 */
export interface SplatManifest {
  version: 1;
  incident_id: string;
  reconstruction_id: string;
  /** Origen del sistema local ENU (ubicación del incidente). */
  origin: { lat: number; lng: number };
  bucket: string;
  /** Carpeta de salida (termina en "/"); el job escribe ahí scene.splat y preview.jpg. */
  output_prefix: string;
  /** URL absoluta donde reportar progreso (POST ReconstructionUpdate). */
  callback_url: string;
  iterations: number;
  max_frames: number;
  sample_fps: number;
  media: {
    id: string;
    label: string;
    source: "citizen" | "drone" | "responder";
    /** Video original si existe (preferido: se muestrea a sample_fps). */
    video_path: string | null;
    /** Posición del teléfono para todo el video (una sola), si hay GPS. */
    lat: number | null;
    lng: number | null;
    accuracy_m: number | null;
    heading_deg: number | null;
    /** Cuadros ya extraídos; los del dron traen su propia posición y altura. */
    frames: {
      path: string;
      t_s: number;
      lat: number | null;
      lng: number | null;
      alt_m: number | null;
      heading_deg: number | null;
    }[];
  }[];
}

/* ───────────── Puente Zello ───────────── */

/** Estado que el puente Zello (tools/zello-bridge) informa en cada latido. */
export interface ZelloBridgeStatus {
  /** true = último latido al detener el puente (Ctrl+C): no es una caída. */
  stopped?: boolean;
  /** true = sesión iniciada en Zello y canal en línea. */
  connected: boolean;
  channel: string;
  /** Usuarios conectados al canal según Zello; null si no se sabe. */
  users_online: number | null;
  /** true = el puente solo escucha (sin voz de ElevenLabs o con --listen-only). */
  listen_only: boolean;
  /** Último problema de conexión, en palabras; null si no hay. */
  error: string | null;
  /** Emergencias abiertas a las que llegan las transmisiones. */
  incident_codes: string[];
  last_transmission: { at: string; from: string; text: string } | null;
  last_spoken: { at: string; text: string } | null;
  /** Hora del puente al mandar el latido (ISO). */
  sent_at: string;
}

export interface ZelloStatusResponse {
  /** null = nunca se ha conectado un puente. */
  status: ZelloBridgeStatus | null;
  /** Hora del servidor al recibir el último latido; null si no hay. */
  received_at: string | null;
  /** true = el último latido tiene más de 30 s: el puente se cayó o perdió la red. */
  stale: boolean;
}
