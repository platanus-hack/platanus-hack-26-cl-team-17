/**
 * Operaciones de servidor sobre misiones de dron, con dependencias inyectadas
 * (las rutas /api pasan el store real, el pipeline y `after()`; las pruebas, dobles).
 */
import type { CreateMissionResponse, DroneFrameResponse, TelemetryResponse } from "@/lib/contract";
import {
  LIMITS,
  type CreateMissionInput,
  type DroneMission,
  type MissionMode,
  type MissionStatus,
  type TelemetryInput,
  type TelemetryPoint,
} from "@/lib/domain";
import { errors, readLimitedBody as readLimitedBodyBase } from "@/lib/http";
import { newToken, sha256Hex } from "@/lib/ids";
import { storagePaths, type FileStorage, type Store } from "@/lib/store/types";
import type { LiveInsightInput, LiveInsightResult } from "@/lib/ai/live";
import { jpegSize } from "./jpeg";
import { deployedTitle, isMissionActive, MAX_ACTIVE_MISSIONS, planMission } from "./plan";

export interface DroneDeps {
  store: Store;
  files: FileStorage;
  now: () => number;
  defer: (task: () => Promise<void>) => void;
  processMedia: (mediaId: string) => Promise<void>;
  /** Observador del video en vivo; sin inyectar usa Claude (o nada si no hay credencial). Lo inyectan las pruebas. */
  analyzeLive?: (input: LiveInsightInput) => Promise<LiveInsightResult>;
}

const iso = (ms: number) => new Date(ms).toISOString();

const MODE_DETAIL: Record<MissionMode, string> = {
  device: "Teléfono como sensor: abre el enlace del modo sensor en el teléfono que vuela o acompaña al dron.",
  api: "Dron real por API: conecta el puente (tools/drone_bridge.py) con el token entregado.",
};

const STATUS_TITLE: Partial<Record<MissionStatus, (label: string) => string>> = {
  launching: (l) => `Dron ${l} despegó`,
  en_route: (l) => `Dron ${l} en camino al incidente`,
  on_station: (l) => `Dron ${l} en posición`,
  returning: (l) => `Dron ${l} retornando`,
  landed: (l) => `Dron ${l} aterrizó`,
  aborted: (l) => `Dron ${l} abortado`,
};

/* ───────────── Personal ───────────── */

export async function createMission(
  deps: DroneDeps,
  incidentId: string,
  input: CreateMissionInput,
): Promise<CreateMissionResponse> {
  const { store } = deps;
  const incident = await store.getIncident(incidentId);
  if (!incident) throw errors.notFound("El incidente no existe.");
  if (incident.status === "closed") throw errors.conflict("El incidente está cerrado.");
  const active = (await store.listMissions(incidentId)).filter(isMissionActive);
  if (active.length >= MAX_ACTIVE_MISSIONS) {
    throw errors.conflict(
      `Ya hay ${active.length} misiones activas en este incidente. Retorna o aborta una antes de desplegar otra.`,
    );
  }
  const plan = planMission({ lat: incident.lat, lng: incident.lng }, input);
  const token = newToken();
  const mission = await store.createMission({
    incident_id: incidentId,
    mode: input.mode,
    ...plan,
    ingest_token_hash: sha256Hex(token),
  });
  await store.addEvent({
    incident_id: incidentId,
    kind: "drone",
    severity: "info",
    title: deployedTitle(mission),
    detail: MODE_DETAIL[input.mode],
    mission_id: mission.id,
  });
  return {
    mission,
    ingest_token: token,
    sensor_path: `/dron/${mission.id}?t=${encodeURIComponent(token)}`,
  };
}

async function requireMission(store: Store, id: string): Promise<DroneMission> {
  const m = await store.getMission(id);
  if (!m) throw errors.notFound("La misión no existe.");
  return m;
}

export async function commandMission(
  deps: DroneDeps,
  missionId: string,
  action: "recall" | "abort" | "resume",
): Promise<DroneMission> {
  const { store } = deps;
  const mission = await requireMission(store, missionId);
  if (!isMissionActive(mission)) throw errors.conflict("La misión ya terminó.");
  const at = iso(deps.now());
  if (action === "resume") {
    if (mission.command === "abort") throw errors.conflict("Una misión abortada no se puede reanudar.");
    if (mission.command === "continue") return mission;
    const updated = await store.updateMission(missionId, { command: "continue" });
    await store.addEvent({
      incident_id: mission.incident_id,
      kind: "drone",
      severity: "info",
      title: `Orden al dron ${mission.label}: reanudar la misión`,
      detail: "El mando retiró la orden de retorno.",
      mission_id: missionId,
    });
    return updated;
  }
  if (mission.command === action) return mission;
  // Un dron que nunca despegó no recibirá la orden: se cierra de inmediato.
  const neverFlew = mission.status === "planned" && mission.last === null;
  const patch =
    neverFlew
      ? { command: action, status: (action === "abort" ? "aborted" : "landed") as MissionStatus, ended_at: at }
      : { command: action };
  const updated = await store.updateMission(missionId, patch);
  await store.addEvent({
    incident_id: mission.incident_id,
    kind: "drone",
    severity: action === "abort" ? "warning" : "notice",
    title:
      action === "abort"
        ? `Orden al dron ${mission.label}: abortar`
        : `Orden al dron ${mission.label}: retornar a la base`,
    detail: neverFlew
      ? "La misión no alcanzó a despegar y quedó cerrada."
      : "El dron recibirá la orden en su próximo envío de telemetría.",
    mission_id: missionId,
  });
  return updated;
}

/* ───────────── Dron (Bearer) ───────────── */

/** Verifica el token de ingesta; misión inexistente o token incorrecto → 401 (no revela cuál). */
export async function authorizeDrone(store: Store, missionId: string, token: string | null): Promise<DroneMission> {
  if (!token) throw errors.unauthorized("Falta el token del dron (Authorization: Bearer …).");
  const mission = await store.getMission(missionId);
  if (!mission || !(await store.verifyIngestToken(missionId, sha256Hex(token)))) {
    throw errors.unauthorized("Token de dron inválido para esta misión.");
  }
  return mission;
}

const TERMINAL: MissionStatus[] = ["landed", "aborted"];

export async function ingestTelemetry(
  deps: DroneDeps,
  mission: DroneMission,
  input: TelemetryInput,
): Promise<TelemetryResponse> {
  const { store } = deps;
  const nowMs = deps.now();
  if (!isMissionActive(mission)) {
    return { ok: true, command: mission.command, status: mission.status };
  }
  const points: TelemetryPoint[] = input.points.map((p) => {
    const t = p.at ? Date.parse(p.at) : nowMs;
    return {
      // Un reloj del teléfono adelantado no puede dejar puntos en el futuro.
      at: iso(Math.min(Number.isFinite(t) ? t : nowMs, nowMs)),
      lat: p.lat,
      lng: p.lng,
      alt_m: p.alt_m,
      heading_deg: p.heading_deg,
      speed_ms: p.speed_ms ?? null,
      battery_pct: p.battery_pct ?? null,
    };
  });
  let updated = await store.appendTelemetry(mission.id, points);

  const next: MissionStatus =
    input.status ?? (mission.status === "planned" ? (mission.mode === "device" ? "on_station" : "launching") : mission.status);
  if (next !== mission.status) {
    const patch: { status: MissionStatus; started_at?: string; ended_at?: string } = { status: next };
    if (!mission.started_at) patch.started_at = points[0].at;
    if (TERMINAL.includes(next)) patch.ended_at = iso(nowMs);
    updated = await store.updateMission(mission.id, patch);
    const title = STATUS_TITLE[next]?.(mission.label);
    if (title) {
      await store.addEvent({
        incident_id: mission.incident_id,
        kind: "drone",
        severity: next === "aborted" ? "warning" : "info",
        title,
        detail: mission.mode === "device" ? "Informado por el teléfono en modo sensor." : "Informado por el dron.",
        mission_id: mission.id,
      });
    }
  } else if (!mission.started_at) {
    updated = await store.updateMission(mission.id, { started_at: points[0].at });
  }
  return { ok: true, command: updated.command, status: updated.status };
}

export interface FrameParams {
  lat: number | null;
  lng: number | null;
  alt: number | null;
  heading: number | null;
  /** Instante de captura (ISO) o null = ahora. */
  t: string | null;
  flush: boolean;
}

/** Interpreta la query de /frame; valores fuera de rango se ignoran (null). */
export function parseFrameParams(url: URL): FrameParams {
  const num = (k: string, min: number, max: number): number | null => {
    const raw = url.searchParams.get(k);
    if (raw === null || raw.trim() === "") return null;
    const v = Number(raw);
    return Number.isFinite(v) && v >= min && v <= max ? v : null;
  };
  const t = url.searchParams.get("t");
  const tMs = t ? (/^\d+(\.\d+)?$/.test(t) ? Number(t) * (Number(t) < 1e11 ? 1000 : 1) : Date.parse(t)) : NaN;
  const flush = url.searchParams.get("flush");
  return {
    lat: num("lat", -90, 90),
    lng: num("lng", -180, 180),
    alt: num("alt", -100, 1000),
    heading: num("heading", 0, 360),
    t: Number.isFinite(tMs) ? iso(tMs) : null,
    flush: flush === "1" || flush === "true",
  };
}

export async function ingestFrame(
  deps: DroneDeps,
  mission: DroneMission,
  bytes: Uint8Array,
  params: FrameParams,
): Promise<DroneFrameResponse> {
  const { store, files } = deps;
  if (mission.status === "aborted") throw errors.conflict("La misión fue abortada; ya no recibe cuadros.");
  if (bytes.byteLength === 0) throw errors.invalid("El cuadro llegó vacío.");
  if (bytes.byteLength > LIMITS.MAX_FRAME_BYTES) throw errors.tooLarge("El cuadro supera los 3 MB.");
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw errors.invalid("El cuadro debe ser una imagen JPEG.");
  const size = jpegSize(bytes);

  const nowMs = deps.now();
  const capturedMs = params.t ? Math.min(Date.parse(params.t), nowMs) : nowMs;
  const lat = params.lat ?? mission.last?.lat ?? null;
  const lng = params.lng ?? mission.last?.lng ?? null;
  const alt = params.alt ?? mission.last?.alt_m ?? null;
  const heading = params.heading ?? mission.last?.heading_deg ?? null;

  let batch = await store.getOpenDroneBatch(mission.id);
  if (!batch) {
    batch = await store.createMedia({
      incident_id: mission.incident_id,
      source: "drone",
      kind: "frames",
      mission_id: mission.id,
      mime: "image/jpeg",
      lat,
      lng,
      heading_deg: heading,
      captured_at: iso(capturedMs),
      reporter_note: "",
      video_status: "none",
      status: "uploading",
    });
  }
  const idx = batch.frames.length;
  const first = batch.captured_at ? Date.parse(batch.captured_at) : capturedMs;
  const path = storagePaths.frame(mission.incident_id, batch.id, idx);
  await files.upload(path, bytes, "image/jpeg");
  await store.addFrames(batch.id, [
    {
      idx,
      t_s: Math.max(0, Math.round((capturedMs - first) / 100) / 10),
      storage_path: path,
      width: size?.width ?? LIMITS.FRAME_LONG_EDGE_PX,
      height: size?.height ?? Math.round((LIMITS.FRAME_LONG_EDGE_PX * 9) / 16),
      lat,
      lng,
      alt_m: alt,
      heading_deg: heading,
    },
  ]);
  const updatedMission = await store.updateMission(mission.id, { frames_received: mission.frames_received + 1 });

  const count = idx + 1;
  const flushed = params.flush || count >= LIMITS.DRONE_BATCH_FRAMES;
  if (flushed) {
    const closed = await store.updateMedia(batch.id, { status: "uploaded" });
    await store.addEvent({
      incident_id: mission.incident_id,
      kind: "media_received",
      severity: "info",
      title: `Lote de dron ${mission.label} — ${closed.label}, ${count} ${count === 1 ? "cuadro" : "cuadros"}`,
      detail:
        mission.mode === "device"
          ? "Cuadros enviados por el teléfono en modo sensor."
          : "Cuadros enviados por el dron.",
      media_id: batch.id,
      mission_id: mission.id,
    });
    const id = batch.id;
    deps.defer(() => deps.processMedia(id));
  }
  return { ok: true, media_id: batch.id, frame_idx: idx, flushed, command: updatedMission.command };
}

/** Lee el cuerpo crudo con tope de tamaño sin cargar más de lo permitido. */
export function readLimitedBody(req: Request, maxBytes: number): Promise<Uint8Array> {
  return readLimitedBodyBase(req, maxBytes, "El cuadro supera los 3 MB.");
}

