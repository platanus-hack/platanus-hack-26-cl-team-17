/**
 * Vistas del puesto de mando (servidor): resumen para la lista de incidentes,
 * snapshot completo de un incidente (con URLs estables de /api/files) y la
 * lógica de datos de crear y editar incidentes desde la central.
 *
 * No depende de next/* ni de la sesión: las rutas autorizan, pasan el store y
 * disparan la IA con `after()`; aquí solo hay datos (probado con el store local).
 */
import type {
  IncidentSnapshot,
  IncidentSummary,
  MediaUrls,
  MediaView,
  RuntimeMode,
  UnchangedResponse,
} from "@/lib/contract";
import type {
  CommEntry,
  CreateIncidentInput,
  DroneMission,
  Incident,
  IncidentType,
  Media,
  TimelineEvent,
  TimelineSeverity,
  UpdateIncidentInput,
} from "@/lib/domain";
import { distanceM } from "@/lib/geo";
import { errors } from "@/lib/http";
import { incidentStatusLabel, incidentTypeLabel } from "@/lib/labels";
import type { IncidentPatch, Store } from "@/lib/store/types";

/** Tope de eventos del snapshot (los más recientes). */
export const MAX_SNAPSHOT_EVENTS = 200;
const MAX_TITLE_CHARS = 140;

export type IncidentCounts = { media: number; comms: number; active_missions: number };

/* ───────────── URLs de archivos ───────────── */

/**
 * URL estable de /api/files para una ruta del bucket. Con `shareKey` agrega `?k=`
 * (enlace de briefing sin sesión). No cambia entre sondeos: el navegador la cachea.
 */
export function fileUrl(storagePath: string, shareKey?: string | null): string {
  const path = storagePath.split("/").map(encodeURIComponent).join("/");
  return shareKey ? `/api/files/${path}?k=${encodeURIComponent(shareKey)}` : `/api/files/${path}`;
}

/**
 * Medio con sus URLs. Póster = primer fotograma clave del análisis (el más
 * informativo) o, si no hay, el primer fotograma. Video solo si terminó de subir.
 */
export function toMediaView(media: Media, shareKey?: string | null): MediaView {
  const frames = [...media.frames].sort((a, b) => a.idx - b.idx);
  const urlFrames: MediaUrls["frames"] = frames.map((f) => ({
    idx: f.idx,
    t_s: f.t_s,
    url: fileUrl(f.storage_path, shareKey),
    width: f.width,
    height: f.height,
  }));
  const keyIdx = media.analysis?.key_frames?.[0]?.frame;
  const poster =
    (keyIdx === undefined ? undefined : urlFrames.find((f) => f.idx === keyIdx)) ?? urlFrames[0] ?? null;
  const video =
    media.video_status === "uploaded" && media.video_path ? fileUrl(media.video_path, shareKey) : null;
  return { ...media, frames, urls: { video, poster: poster ? poster.url : null, frames: urlFrames } };
}

/* ───────────── Lista ───────────── */

export function toSummary(incident: Incident, counts?: IncidentCounts): IncidentSummary {
  const s = incident.situation;
  return {
    id: incident.id,
    code: incident.code,
    type: incident.type,
    title: incident.title,
    address: incident.address,
    lat: incident.lat,
    lng: incident.lng,
    status: incident.status,
    origin: incident.origin,
    verified: incident.verified,
    created_at: incident.created_at,
    updated_at: incident.updated_at,
    rev: incident.rev,
    headline: s?.headline?.trim() || null,
    severity: s?.severity ?? null,
    // Sin informe queda null: la UI lo muestra como "sin evaluar", nunca como "sin víctimas".
    trapped_status: s?.trapped?.status ?? null,
    media_count: counts?.media ?? 0,
    comms_count: counts?.comms ?? 0,
    active_missions: counts?.active_missions ?? 0,
  };
}

const STATUS_ORDER: Record<Incident["status"], number> = { active: 0, controlled: 1, closed: 2 };

/** Activos primero, luego controlados y cerrados; dentro de cada grupo, los más nuevos arriba. */
export function sortSummaries(list: IncidentSummary[]): IncidentSummary[] {
  return [...list].sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      Date.parse(b.created_at) - Date.parse(a.created_at) ||
      a.code.localeCompare(b.code),
  );
}

export async function listIncidentSummaries(store: Store): Promise<IncidentSummary[]> {
  const incidents = await store.listIncidents();
  const counts = incidents.length ? await store.getIncidentCounts(incidents.map((i) => i.id)) : {};
  return sortSummaries(incidents.map((i) => toSummary(i, counts[i.id])));
}

/* ───────────── Snapshot ───────────── */

/** `?rev=` válido (entero ≥ 0) o null. */
export function parseRev(raw: string | null | undefined): number | null {
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export function sharePaths(incident: Pick<Incident, "id" | "code" | "share_key">): IncidentSnapshot["share"] {
  return {
    report_path: `/reportar/${encodeURIComponent(incident.code)}`,
    briefing_path: `/en-ruta/${encodeURIComponent(incident.id)}?k=${encodeURIComponent(incident.share_key)}`,
  };
}

export interface SnapshotParts {
  incident: Incident;
  media: Media[];
  comms: CommEntry[];
  missions: DroneMission[];
  events: TimelineEvent[];
}

export function buildSnapshot(parts: SnapshotParts, mode: RuntimeMode, now: Date): IncidentSnapshot {
  // Orden estable: a igual `at`, se respeta el orden del store (último insertado primero).
  const events = [...parts.events]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, MAX_SNAPSHOT_EVENTS);
  return {
    incident: parts.incident,
    media: parts.media.map((m) => toMediaView(m)),
    comms: [...parts.comms].sort((a, b) => a.seq - b.seq),
    missions: parts.missions,
    events,
    mode,
    server_time: now.toISOString(),
    share: sharePaths(parts.incident),
  };
}

export const INCIDENT_NOT_FOUND = "No encontramos este incidente.";

/**
 * Con `rev` igual al actual responde `UnchangedResponse` sin cargar hijos (sondeo barato).
 * Lanza 404 si el incidente no existe.
 */
export async function loadIncidentSnapshot(
  store: Store,
  id: string,
  opts: { rev: number | null; mode: RuntimeMode; now?: Date },
): Promise<IncidentSnapshot | UnchangedResponse> {
  const now = opts.now ?? new Date();
  if (opts.rev !== null) {
    const current = await store.getIncidentRev(id);
    if (current === null) throw errors.notFound(INCIDENT_NOT_FOUND);
    if (current === opts.rev) return { unchanged: true, rev: current, server_time: now.toISOString() };
  }
  const incident = await store.getIncident(id);
  if (!incident) throw errors.notFound(INCIDENT_NOT_FOUND);
  const [media, comms, missions, events] = await Promise.all([
    store.listMedia(id),
    store.listComms(id),
    store.listMissions(id),
    store.listEvents(id, MAX_SNAPSHOT_EVENTS),
  ]);
  return buildSnapshot({ incident, media, comms, missions, events }, opts.mode, now);
}

/* ───────────── Crear incidente (central) ───────────── */

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** "Incendio estructural — Av. Matta 1234" (o solo el tipo si no hay dirección). */
export function defaultIncidentTitle(type: IncidentType, address: string): string {
  const label = incidentTypeLabel[type];
  const a = address.trim();
  return clip(a ? `${label} — ${a}` : label, MAX_TITLE_CHARS);
}

/** Crea el incidente verificado de la central y registra `incident_created`. */
export async function createCommandIncident(
  store: Store,
  input: CreateIncidentInput,
  by: { name: string; demo: boolean },
): Promise<Incident> {
  const address = input.address.trim();
  const created = await store.createIncident({
    type: input.type,
    title: input.title?.trim() || defaultIncidentTitle(input.type, address),
    address,
    lat: input.lat,
    lng: input.lng,
    description: input.description.trim(),
    origin: "command",
    verified: true,
  });
  await store.addEvent({
    incident_id: created.id,
    kind: "incident_created",
    severity: "notice",
    title: `Emergencia creada por la central — ${created.code}`,
    detail: [incidentTypeLabel[created.type], address, by.demo ? "" : `Por ${by.name}`]
      .filter(Boolean)
      .join(" · "),
  });
  // Se relee para devolver el `rev` que ya incluye el evento.
  return (await store.getIncident(created.id)) ?? created;
}

/* ───────────── Editar incidente (central) ───────────── */

export interface IncidentUpdatePlan {
  /** Solo los campos que cambian de verdad. */
  patch: IncidentPatch;
  /** Cambios legibles, p. ej. "Estado: Activo → Controlado". */
  changes: string[];
  title: string;
  severity: TimelineSeverity;
  /** Cambió la ubicación o el tipo: hay que refusionar (la escena y el informe dependen de eso). */
  refuse: boolean;
}

function quoted(text: string): string {
  const t = text.trim();
  return t ? `«${clip(t, 60)}»` : "(vacío)";
}

/** null si la solicitud no cambia nada. */
export function planIncidentUpdate(current: Incident, input: UpdateIncidentInput): IncidentUpdatePlan | null {
  const patch: IncidentPatch = {};
  const changes: string[] = [];
  let severity: TimelineSeverity = "info";

  if (input.status !== undefined && input.status !== current.status) {
    patch.status = input.status;
    changes.push(`Estado: ${incidentStatusLabel[current.status]} → ${incidentStatusLabel[input.status]}`);
    severity = "notice";
  }
  if (input.verified !== undefined && input.verified !== current.verified) {
    patch.verified = input.verified;
    changes.push(input.verified ? "Emergencia verificada por el mando" : "Marcada como no verificada");
    severity = "notice";
  }
  if (input.type !== undefined && input.type !== current.type) {
    patch.type = input.type;
    changes.push(`Tipo: ${incidentTypeLabel[current.type]} → ${incidentTypeLabel[input.type]}`);
  }
  if (input.title !== undefined && input.title.trim() !== current.title) {
    patch.title = input.title.trim();
    changes.push(`Título: ${quoted(current.title)} → ${quoted(patch.title)}`);
  }
  if (input.address !== undefined && input.address.trim() !== current.address) {
    patch.address = input.address.trim();
    changes.push(`Dirección: ${quoted(current.address)} → ${quoted(patch.address)}`);
  }
  const lat = input.lat ?? current.lat;
  const lng = input.lng ?? current.lng;
  if (lat !== current.lat || lng !== current.lng) {
    patch.lat = lat;
    patch.lng = lng;
    const moved = Math.round(distanceM(current, { lat, lng }));
    changes.push(`Ubicación corregida (${moved < 1000 ? `${moved} m` : `${(moved / 1000).toFixed(1).replace(".", ",")} km`})`);
  }
  if (input.description !== undefined && input.description.trim() !== current.description) {
    patch.description = input.description.trim();
    changes.push("Descripción actualizada");
  }

  if (changes.length === 0) return null;
  return {
    patch,
    changes,
    title: changes.length === 1 ? changes[0] : `${changes[0]} y ${changes.length - 1} cambio${changes.length > 2 ? "s" : ""} más`,
    severity,
    refuse: patch.lat !== undefined || patch.type !== undefined,
  };
}

/**
 * Aplica el plan y registra `incident_updated`. Devuelve el incidente releído
 * (con el `rev` que incluye el evento) y si hay que pedir la fusión.
 */
export async function updateCommandIncident(
  store: Store,
  id: string,
  input: UpdateIncidentInput,
  by: { name: string; demo: boolean },
): Promise<{ incident: Incident; refuse: boolean }> {
  const current = await store.getIncident(id);
  if (!current) throw errors.notFound(INCIDENT_NOT_FOUND);
  const plan = planIncidentUpdate(current, input);
  if (!plan) return { incident: current, refuse: false };
  const updated = await store.updateIncident(id, plan.patch);
  await store.addEvent({
    incident_id: id,
    kind: "incident_updated",
    severity: plan.severity,
    title: plan.title,
    detail: [...plan.changes, by.demo ? "" : `Por ${by.name}`].filter(Boolean).join(" · "),
  });
  return { incident: (await store.getIncident(id)) ?? updated, refuse: plan.refuse };
}
