/**
 * Pipeline de IA (solo servidor): análisis de cada medio, fusión de fuentes
 * (informe de situación + escena) y análisis de comunicaciones.
 *
 * Las funciones públicas NUNCA lanzan: capturan todo, lo registran con
 * console.error, dejan un evento "error" en la línea de tiempo cuando se puede
 * y actualizan el estado (medio o `incident.pipeline`).
 *
 * Sin credencial de Anthropic no hay motor (`engine: null`): los medios quedan como
 * fallidos con el motivo y la fusión y la radio no corren. No hay respaldo inventado.
 *
 * Reglas de vida o muerte que se respetan aquí:
 *  - Las alertas de personas se emiten apenas se analiza un medio, sin esperar la fusión.
 */
import { LIMITS } from "@/lib/domain";
import { normalizeDeg, toLocal, type LatLng } from "@/lib/geo";
import type {
  AnalysisEngine,
  Cardinal,
  CommEntry,
  CommsAnalysis,
  Confidence,
  HazardKind,
  Incident,
  Media,
  MediaAnalysis,
  MediaFrame,
  PersonStatus,
  SceneModel,
  SituationReport,
  TimelineSeverity,
  TrappedStatus,
} from "@/lib/domain";
import type { FileStorage, NewEvent, Store } from "@/lib/store/types";
import { recordServerError } from "@/lib/server/diagnostics";
import { isVigiaVoiceComm } from "@/lib/server/zello/channels";
import type { SceneSanitizeContext } from "./scene-post";
import { isImageMediaType } from "./types";
import type {
  CommsAnalysisInput,
  Engine,
  FrameImage,
  FusionInput,
  FusionMedia,
  ImageMediaType,
  IncidentContext,
  KeyFrameImage,
  MediaAnalysisInput,
} from "./types";

/* ════════════════════════════ Tipos públicos ════════════════════════════ */

export interface PipelineDeps {
  store: Store;
  files: FileStorage;
  /** null sin credencial de Anthropic: no se analiza nada. */
  engine: Engine | null;
  /** Extrae fotogramas del video en el servidor (ffmpeg) y los registra en el store. */
  extractFrames: (media: Media) => Promise<MediaFrame[]>;
  now?: () => Date;
  /** Post-proceso de escenas. Por defecto `sanitizeScene` de ./scene-post; se inyecta en pruebas. */
  sanitizeScene?: (scene: SceneModel, ctx: SceneSanitizeContext) => SceneModel;
  /**
   * Anclaje de la escena saneada al mapa real (OSM). Se llama al empezar la fusión (así el
   * mapa se descarga mientras responde el modelo) y devuelve la función que ancla, que debe
   * resolver siempre (con la escena tal cual si falla o tarda). Sin inyectar no se ancla.
   */
  anchorScene?: (
    incident: Pick<Incident, "lat" | "lng" | "type" | "scene">,
  ) => (scene: SceneModel, media: readonly Media[]) => Promise<SceneModel>;
}

export interface Pipeline {
  processMedia(mediaId: string, opts?: { force?: boolean }): Promise<void>;
  requestFusion(incidentId: string, opts?: { force?: boolean }): Promise<void>;
  requestCommsAnalysis(incidentId: string): Promise<void>;
}

/* ════════════════════════════ Constantes ════════════════════════════ */

const LOCK_TTL_S = 600;
const MAX_ROUNDS = 3;
const MAX_KEY_FRAMES = 6;
/** Eventos que se revisan para no duplicar alertas. */
const DEDUPE_EVENT_WINDOW = 1000;

type FusionTask = "situation" | "scene";

const FUSION_TASK_LABEL: Record<FusionTask, { name: string; the: string }> = {
  situation: {
    name: "informe de situación",
    the: "el informe de situación",
  },
  scene: {
    name: "reconstrucción de la escena",
    the: "la reconstrucción de la escena",
  },
};

const HAZARD_LABEL: Record<HazardKind, string> = {
  gas_cylinder: "cilindro de gas",
  gas_line: "red o matriz de gas",
  power_lines: "tendido eléctrico",
  electrical: "riesgo eléctrico",
  fuel_spill: "derrame de combustible",
  hazmat_placard: "materiales peligrosos (rombo)",
  collapse_risk: "riesgo de colapso",
  explosion_risk: "riesgo de explosión",
  ev_battery: "batería de vehículo eléctrico",
  solar_panels: "paneles solares",
  traffic: "tránsito",
  crowd: "aglomeración de personas",
  water_hazard: "riesgo acuático",
  other: "otro peligro",
};

/** Estados de persona que disparan alerta inmediata. */
const ALERT_PERSON_LABEL: Partial<Record<PersonStatus, string>> = {
  trapped: "atrapada",
  at_window_or_balcony: "en ventana o balcón",
  on_roof: "en el techo",
};

const CONFIDENCE_LABEL: Record<Confidence, string> = {
  low: "baja",
  medium: "media",
  high: "alta",
};

const TRAPPED_LABEL: Record<TrappedStatus, string> = {
  confirmed: "personas atrapadas: confirmado",
  probable: "personas atrapadas: probable",
  possible: "personas atrapadas: posible",
  no_evidence: "personas atrapadas: sin evidencia (no descarta víctimas)",
  cleared_by_unit: "personas atrapadas: descartado por unidad en el lugar",
};

/* ════════════════════════════ Utilidades puras ════════════════════════════ */

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message.trim();
  if (typeof err === "string" && err.trim()) return err.trim();
  return "Error desconocido.";
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function labelNumber(label: string): number {
  const m = /\d+/.exec(label);
  return m ? Number.parseInt(m[0], 10) : Number.MAX_SAFE_INTEGER;
}

function ms(iso: string | null | undefined): number {
  if (!iso) return Number.NaN;
  return Date.parse(iso);
}

function toIncidentContext(i: Incident): IncidentContext {
  return {
    id: i.id,
    code: i.code,
    type: i.type,
    title: i.title,
    address: i.address,
    lat: i.lat,
    lng: i.lng,
    description: i.description,
    status: i.status,
    created_at: i.created_at,
  };
}

/** Tipo real de la imagen por su firma de bytes; null si no se reconoce. */
export function sniffImageType(b: Uint8Array): ImageMediaType | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return "image/png";
  }
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    return "image/gif";
  }
  if (
    b.length >= 12 &&
    String.fromCharCode(b[0], b[1], b[2], b[3]) === "RIFF" &&
    String.fromCharCode(b[8], b[9], b[10], b[11]) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * Formato a enviar a la IA, o null si no es una imagen que la API acepte
 * (SVG, vacía, demasiado grande). La firma de bytes manda sobre el tipo declarado.
 */
export function resolveImageType(bytes: Uint8Array, contentType: string): ImageMediaType | null {
  if (bytes.length === 0 || bytes.length > LIMITS.MAX_FRAME_BYTES) return null;
  const declared = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  if (declared === "image/svg+xml") return null;
  const sniffed = sniffImageType(bytes);
  if (sniffed) return sniffed;
  const normalized = declared === "image/jpg" ? "image/jpeg" : declared;
  return isImageMediaType(normalized) ? normalized : null;
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/** Qué tan importante es el contenido de un análisis para elegir fotogramas clave. */
function analysisPriority(a: MediaAnalysis): number {
  let score = 0;
  for (const p of a.people) {
    if (p.status === "trapped" || p.status === "at_window_or_balcony" || p.status === "on_roof") {
      score = Math.max(score, p.confidence === "low" ? 80 : 100);
    } else if (p.status === "injured") {
      score = Math.max(score, 70);
    }
  }
  if (a.vehicles.some((v) => v.entrapment_suspected)) score = Math.max(score, 85);
  if (a.fire.flames_visible) score = Math.max(score, 60);
  else if (a.fire.present) score = Math.max(score, 50);
  if (a.hazards.some((h) => h.severity === "high")) score = Math.max(score, 45);
  if (a.fire.smoke.present) score = Math.max(score, 30);
  if (!a.usable) score -= 50;
  const conf = a.confidence === "high" ? 3 : a.confidence === "medium" ? 2 : 1;
  return score + conf;
}

export interface KeyFrameCandidate {
  media: Media;
  frame: MediaFrame;
  caption: string;
}

const CARDINAL_DEG: Record<Exclude<Cardinal, "unknown">, number> = {
  N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315,
};
/** Separación mínima entre puntos de vista para considerarlos ángulos distintos. */
const DISTINCT_VIEW_DEG = 60;

function angleGap(a: number, b: number): number {
  const d = Math.abs(normalizeDeg(a) - normalizeDeg(b)) % 360;
  return d > 180 ? 360 - d : d;
}

function isAerial(fm: FusionMedia): boolean {
  return fm.media.source === "drone" || fm.analysis?.viewpoint.elevation === "aerial";
}

/**
 * Desde qué lado del incidente se grabó (rumbo del incidente a la cámara, 0 = N):
 * posición GPS del medio (o del cuadro de dron); si no, rumbo de la brújula + 180°;
 * si no, la orientación que estimó el análisis + 180°. null si no se sabe.
 */
export function viewpointBearing(fm: FusionMedia, origin: LatLng | null): number | null {
  const m = fm.media;
  const gpsFrame = m.frames.find((f) => f.lat !== null && f.lng !== null);
  const pos =
    m.lat !== null && m.lng !== null
      ? { lat: m.lat, lng: m.lng }
      : gpsFrame && gpsFrame.lat !== null && gpsFrame.lng !== null
        ? { lat: gpsFrame.lat, lng: gpsFrame.lng }
        : null;
  if (origin && pos) {
    const { x, y } = toLocal(origin, pos);
    if (Number.isFinite(x) && Number.isFinite(y) && Math.hypot(x, y) >= 3) {
      return normalizeDeg((Math.atan2(x, y) * 180) / Math.PI);
    }
  }
  const heading = m.heading_deg ?? gpsFrame?.heading_deg ?? null;
  if (heading !== null && Number.isFinite(heading)) return normalizeDeg(heading + 180);
  const facing = fm.analysis?.viewpoint.facing;
  if (facing && facing !== "unknown") return normalizeDeg(CARDINAL_DEG[facing] + 180);
  return null;
}

/**
 * Candidatos a fotograma clave en orden de preferencia, para maximizar la
 * cobertura de puntos de vista:
 *  1. la vista aérea del dron (si existe), siempre;
 *  2. un cuadro por medio distinto, eligiendo primero los medios cuyo ángulo
 *     está a ≥ 60° de los ya elegidos (o de ángulo desconocido) y, a igualdad,
 *     los de contenido más importante;
 *  3. el resto de los key_frames de cada medio, alternando entre medios.
 * Nunca de medios demo (sus cuadros son ilustraciones) ni de cuadros
 * inexistentes o SVG. No limita a 6: quien descarga se detiene al juntar 6
 * imágenes válidas (si una descarga falla, sigue el próximo candidato).
 */
export function rankKeyFrameCandidates(media: FusionMedia[], origin: LatLng | null = null): KeyFrameCandidate[] {
  interface Group {
    priority: number;
    order: number;
    aerial: boolean;
    bearing: number | null;
    list: KeyFrameCandidate[];
  }
  const groups: Group[] = [];
  media.forEach((fm, order) => {
    const a = fm.analysis;
    if (!a) return;
    const byIdx = new Map(fm.media.frames.map((f) => [f.idx, f] as const));
    const seen = new Set<number>();
    const list: KeyFrameCandidate[] = [];
    for (const kf of a.key_frames) {
      const frame = byIdx.get(kf.frame);
      if (!frame || seen.has(kf.frame)) continue;
      if (/\.svg$/i.test(frame.storage_path)) continue;
      seen.add(kf.frame);
      list.push({ media: fm.media, frame, caption: kf.caption });
    }
    if (list.length) {
      groups.push({ priority: analysisPriority(a), order, aerial: isAerial(fm), bearing: viewpointBearing(fm, origin), list });
    }
  });
  const byPriority = (x: Group, y: Group) => y.priority - x.priority || x.order - y.order;

  // 1 y 2: un cuadro por medio, en orden de cobertura.
  const pending = [...groups].sort(byPriority);
  const picked: Group[] = [];
  const aerial = pending.find((g) => g.aerial);
  if (aerial) {
    picked.push(aerial);
    pending.splice(pending.indexOf(aerial), 1);
  }
  while (pending.length > 0) {
    const bearings = picked.map((g) => g.bearing).filter((b): b is number => b !== null);
    const novelty = (g: Group): number => {
      if (g.aerial) return 1; // otra vista aérea aporta menos que un ángulo nuevo en tierra
      if (g.bearing === null) return 1;
      if (bearings.length === 0) return 2;
      return Math.min(...bearings.map((b) => angleGap(b, g.bearing as number))) >= DISTINCT_VIEW_DEG ? 2 : 0;
    };
    let best = 0;
    for (let i = 1; i < pending.length; i++) {
      const d = novelty(pending[i]) - novelty(pending[best]);
      if (d > 0 || (d === 0 && byPriority(pending[i], pending[best]) < 0)) best = i;
    }
    picked.push(pending[best]);
    pending.splice(best, 1);
  }

  const out: KeyFrameCandidate[] = picked.map((g) => g.list[0]);
  // 3: resto de los cuadros, alternando entre medios en orden de prioridad.
  const rest = [...groups].sort(byPriority);
  for (let round = 1; rest.some((g) => g.list.length > round); round++) {
    for (const g of rest) {
      const c = g.list[round];
      if (c) out.push(c);
    }
  }
  return out;
}

function sortFusionMedia(media: Media[]): FusionMedia[] {
  return [...media]
    .sort((a, b) => labelNumber(a.label) - labelNumber(b.label) || a.label.localeCompare(b.label))
    .map((m) => ({ media: m, analysis: m.analysis, analysis_engine: m.analysis_engine }));
}

function contradictionKey(c: SituationReport["contradictions"][number]): string {
  const sources = [...new Set(c.sources.map((s) => s.trim().toUpperCase()).filter(Boolean))].sort();
  return sources.length ? sources.join("|") : c.description.trim().toLowerCase();
}

function situationEventSeverity(s: SituationReport): TimelineSeverity {
  if (s.trapped.status === "confirmed" || s.trapped.status === "probable") return "critical";
  if (s.trapped.status === "possible") return "warning";
  if (s.severity === "critical") return "critical";
  if (s.severity === "high") return "warning";
  if (s.severity === "moderate") return "notice";
  return "info";
}

/* ════════════════════════════ Pipeline ════════════════════════════ */

export function createPipeline(deps: PipelineDeps): Pipeline {
  const { store, files, engine } = deps;
  const clock = deps.now ?? (() => new Date());
  const nowIso = () => clock().toISOString();

  async function sanitize(scene: SceneModel, ctx: SceneSanitizeContext): Promise<SceneModel> {
    const fn = deps.sanitizeScene ?? (await import("./scene-post")).sanitizeScene;
    return fn(scene, ctx);
  }

  /** Prepara el anclaje al mapa real. Nunca lanza: ante cualquier fallo se guarda sin anclar. */
  function prepareAnchor(incident: Incident): (scene: SceneModel, media: readonly Media[]) => Promise<SceneModel> {
    let run: ((scene: SceneModel, media: readonly Media[]) => Promise<SceneModel>) | null = null;
    try {
      run = deps.anchorScene ? deps.anchorScene(incident) : null;
    } catch (err) {
      console.error("[pipeline] no se pudo preparar el anclaje al mapa", incident.id, err);
    }
    return async (scene, media) => {
      if (!run) return scene;
      try {
        return await run(scene, media);
      } catch (err) {
        console.error("[pipeline] no se pudo anclar la escena al mapa", incident.id, err);
        return scene;
      }
    };
  }

  /** Agrega un evento sin dejar que un fallo del store corte el flujo. */
  async function safeEvent(input: NewEvent): Promise<void> {
    try {
      await store.addEvent({ at: nowIso(), ...input });
    } catch (err) {
      console.error("[pipeline] no se pudo registrar el evento", input.title, err);
    }
  }

  async function safePipelinePatch(
    incidentId: string,
    pipeline: Partial<Incident["pipeline"]>,
  ): Promise<void> {
    try {
      await store.updateIncident(incidentId, { pipeline });
    } catch (err) {
      console.error("[pipeline] no se pudo actualizar el estado del pipeline", incidentId, err);
    }
  }

  async function existingEventKeys(incidentId: string): Promise<Set<string>> {
    try {
      const events = await store.listEvents(incidentId, DEDUPE_EVENT_WINDOW);
      return new Set(events.map((e) => `${e.kind}\n${e.media_id ?? ""}\n${e.title}`));
    } catch (err) {
      console.error("[pipeline] no se pudieron leer los eventos para deduplicar", err);
      return new Set();
    }
  }

  /** Descarga cuadros en orden de idx; omite los que no son imagen aceptable. */
  async function downloadFrames(frames: MediaFrame[], max: number): Promise<FrameImage[]> {
    const out: FrameImage[] = [];
    for (const f of [...frames].sort((a, b) => a.idx - b.idx)) {
      if (out.length >= max) break;
      try {
        const { bytes, contentType } = await files.download(f.storage_path);
        const mediaType = resolveImageType(bytes, contentType);
        if (!mediaType) continue;
        out.push({ idx: f.idx, t_s: f.t_s, media_type: mediaType, base64: bytesToBase64(bytes) });
      } catch (err) {
        console.error("[pipeline] no se pudo descargar el fotograma", f.storage_path, err);
      }
    }
    return out;
  }

  async function failMedia(media: Media, message: string): Promise<void> {
    try {
      await store.updateMedia(media.id, { status: "failed", error: message });
    } catch (err) {
      console.error("[pipeline] no se pudo marcar el medio como fallido", media.id, err);
    }
    await safeEvent({
      incident_id: media.incident_id,
      kind: "media_failed",
      severity: "warning",
      title: `No se pudo analizar ${media.label}`,
      detail: message,
      media_id: media.id,
    });
  }

  async function emitMediaAlerts(media: Media, analysis: MediaAnalysis) {
    const existing = await existingEventKeys(media.incident_id);
    const candidates: NewEvent[] = [];
    for (const p of analysis.people) {
      const where = ALERT_PERSON_LABEL[p.status];
      if (!where || (p.confidence !== "medium" && p.confidence !== "high")) continue;
      const location = clip(p.location, 90) || "ubicación no precisada";
      const frames = p.frame_refs.length ? ` Fotogramas: ${p.frame_refs.join(", ")}.` : "";
      candidates.push({
        incident_id: media.incident_id,
        kind: "alert",
        severity: "critical",
        title: `Posible persona atrapada — ${media.label}: ${location}`,
        detail: clip(
          `${p.count > 0 ? `${p.count} persona(s)` : "Persona(s)"} ${where}. ${p.description} Confianza ${CONFIDENCE_LABEL[p.confidence]}.${frames}`,
          400,
        ),
        media_id: media.id,
      });
    }
    for (const h of analysis.hazards) {
      if (h.severity !== "high") continue;
      candidates.push({
        incident_id: media.incident_id,
        kind: "alert",
        severity: "warning",
        title: `Peligro: ${capitalize(HAZARD_LABEL[h.kind])} — ${media.label}`,
        detail: clip(`${h.description}`, 400),
        media_id: media.id,
      });
    }
    for (const ev of candidates) {
      const key = `${ev.kind}\n${ev.media_id ?? ""}\n${ev.title}`;
      if (existing.has(key)) continue;
      existing.add(key);
      await safeEvent(ev);
    }
  }

  /* ── Medios ── */

  async function processMediaInner(mediaId: string, force: boolean): Promise<void> {
    const media = await store.getMedia(mediaId);
    if (!media) {
      console.error("[pipeline] medio inexistente", mediaId);
      return;
    }
    if (media.analysis && !force) {
      // Ya trae análisis: no se reanaliza, pero sí alerta y entra a la fusión.
      let current = media;
      if (media.status !== "analyzed") {
        try {
          current = await store.updateMedia(media.id, {
            status: "analyzed",
            error: null,
            analyzed_at: media.analyzed_at ?? nowIso(),
          });
        } catch (err) {
          console.error("[pipeline] no se pudo marcar como analizado el medio precargado", media.id, err);
        }
      }
      await emitMediaAlerts(current, media.analysis);
      await requestFusionInner(media.incident_id, false);
      return;
    }
    const incident = await store.getIncident(media.incident_id);
    if (!incident) {
      console.error("[pipeline] incidente inexistente para el medio", mediaId);
      return;
    }

    if (!engine) {
      await failMedia(media, "No hay IA configurada en el servidor (falta la credencial de Anthropic): este medio no se analiza.");
      return;
    }

    const hasNote = media.reporter_note.trim().length > 0;
    const videoReady = Boolean(media.video_path) && media.video_status === "uploaded";
    if (media.frames.length === 0 && !videoReady && !hasNote) {
      // El video aún sube: se procesa cuando termine. Si no, no hay nada que analizar.
      if (media.video_status === "uploading") return;
      await failMedia(media, "El medio no trae fotogramas, video ni nota que analizar.");
      return;
    }

    await store.updateMedia(media.id, { status: "analyzing", error: null });

    const extract = async (): Promise<{ frames: MediaFrame[] } | { error: string }> => {
      try {
        return { frames: await deps.extractFrames(media) };
      } catch (err) {
        console.error("[pipeline] falló la extracción de fotogramas en el servidor", media.id, err);
        recordServerError("analisis", err, {
          incidentId: media.incident_id,
          incidentCode: incident.code,
          context: `Extracción de fotogramas de ${media.label}`,
        });
        return { error: errorMessage(err) };
      }
    };

    let frames = media.frames;
    let extractionError: string | null = null;
    const extractFirst = frames.length === 0 && videoReady;
    if (extractFirst) {
      const r = await extract();
      if ("error" in r) extractionError = r.error;
      else frames = r.frames;
    }
    let images = await downloadFrames(frames, LIMITS.MAX_FRAMES_PER_MEDIA);
    if (images.length === 0 && videoReady && !extractFirst) {
      // Los cuadros subidos no sirven (p. ej. SVG o corruptos): se intenta con el video.
      const r = await extract();
      if ("error" in r) extractionError = r.error;
      else {
        frames = r.frames;
        images = await downloadFrames(frames, LIMITS.MAX_FRAMES_PER_MEDIA);
      }
    }

    if (images.length === 0 && !hasNote) {
      await failMedia(
        media,
        extractionError
          ? `No se pudieron obtener fotogramas del video: ${extractionError}`
          : "No hay fotogramas utilizables en este medio.",
      );
      return;
    }
    if (images.length === 0 && extractionError) {
      await safeEvent({
        incident_id: media.incident_id,
        kind: "error",
        severity: "notice",
        title: `${media.label}: sin fotogramas, se analiza solo la nota`,
        detail: extractionError,
        media_id: media.id,
      });
    }

    const input: MediaAnalysisInput = {
      incident: toIncidentContext(incident),
      media: { ...media, frames },
      frames: images,
      now: nowIso(),
    };

    let analysis: MediaAnalysis;
    try {
      analysis = await engine.analyzeMedia(input);
    } catch (err) {
      console.error("[pipeline] falló el análisis del medio", media.id, err);
      recordServerError("analisis", err, { incidentId: media.incident_id, incidentCode: incident.code, context: `Análisis de ${media.label}` });
      await failMedia(media, `No se pudo analizar ${media.label}: ${errorMessage(err)}`);
      // La nota del vecino igual puede aportar a la fusión (p. ej. "hay gente adentro").
      await requestFusionInner(media.incident_id, false);
      return;
    }

    const updated = await store.updateMedia(media.id, {
      status: "analyzed",
      error: null,
      analysis,
      analysis_engine: engine.kind,
      analyzed_at: nowIso(),
    });
    await safeEvent({
      incident_id: media.incident_id,
      kind: "media_analyzed",
      severity: "info",
      title: `${media.label} analizado`,
      detail: clip(analysis.summary, 400),
      media_id: media.id,
    });
    await emitMediaAlerts(updated, analysis);
    await requestFusionInner(media.incident_id, false);
  }

  /* ── Fusión ── */

  async function loadKeyFrames(media: FusionMedia[], origin: LatLng | null): Promise<KeyFrameImage[]> {
    const out: KeyFrameImage[] = [];
    for (const c of rankKeyFrameCandidates(media, origin)) {
      if (out.length >= MAX_KEY_FRAMES) break;
      const [img] = await downloadFrames([c.frame], 1);
      if (img) out.push({ ...img, media_label: c.media.label, caption: c.caption });
    }
    return out;
  }

  interface TaskOutcome<T> {
    ok: boolean;
    value: T | null;
    kind: AnalysisEngine | null;
  }

  async function runFusionTask<T>(
    incidentId: string,
    task: FusionTask,
    run: (e: Engine) => Promise<T>,
    save: (value: T, kind: AnalysisEngine) => Promise<void>,
    errors: string[],
  ): Promise<TaskOutcome<T>> {
    const label = FUSION_TASK_LABEL[task];
    const fail = async (err: unknown, title: string): Promise<TaskOutcome<T>> => {
      recordServerError("analisis", err, { incidentId, context: title });
      errors.push(`${capitalize(label.name)}: ${errorMessage(err)}`);
      await safePipelinePatch(incidentId, { fusion_error: errors.join(" · ") });
      await safeEvent({
        incident_id: incidentId,
        kind: "error",
        severity: "warning",
        title,
        detail: clip(errorMessage(err), 400),
      });
      return { ok: false, value: null, kind: null };
    };

    if (!engine) return { ok: false, value: null, kind: null };
    let value: T;
    const kind: AnalysisEngine = engine.kind;
    try {
      value = await run(engine);
    } catch (err) {
      console.error(`[pipeline] falló ${label.name}`, incidentId, err);
      return fail(err, `Falló ${label.the}`);
    }

    try {
      await save(value, kind);
    } catch (err) {
      console.error(`[pipeline] no se pudo guardar ${label.name}`, incidentId, err);
      return fail(err, `No se pudo guardar ${label.the}`);
    }
    return { ok: true, value, kind };
  }

  async function fusionRound(incidentId: string, startedAt: string): Promise<boolean> {
    await store.updateIncident(incidentId, {
      pipeline: { fusion_status: "running", fusion_started_at: startedAt, fusion_error: null },
    });
    const incident = await store.getIncident(incidentId);
    if (!incident) return false;
    const anchor = prepareAnchor(incident);
    const [mediaList, comms] = await Promise.all([
      store.listMedia(incidentId),
      store.listComms(incidentId),
    ]);
    const media = sortFusionMedia(mediaList);
    const origin =
      Number.isFinite(incident.lat) && Number.isFinite(incident.lng) ? { lat: incident.lat, lng: incident.lng } : null;
    const keyFrames = await loadKeyFrames(media, origin);
    const input: FusionInput = {
      incident: toIncidentContext(incident),
      media,
      comms,
      commsAnalysis: incident.comms_analysis,
      keyFrames,
      previousSituation: incident.situation,
      previousScene: incident.scene,
      now: nowIso(),
    };
    const errors: string[] = [];

    const [situation, scene] = await Promise.all([
      runFusionTask<SituationReport>(
        incidentId,
        "situation",
        (e) => e.fuseSituation(input),
        async (value, kind) => {
          await store.updateIncident(incidentId, {
            situation: value,
            situation_engine: kind,
            situation_updated_at: nowIso(),
          });
        },
        errors,
      ),
      runFusionTask<SceneModel>(
        incidentId,
        "scene",
        (e) => e.fuseScene(input),
        async (value, kind) => {
          const clean = await anchor(
            await sanitize(value, {
              incident: { lat: incident.lat, lng: incident.lng },
              media: mediaList,
            }),
            mediaList,
          );
          await store.updateIncident(incidentId, {
            scene: clean,
            scene_engine: kind,
            scene_updated_at: nowIso(),
          });
        },
        errors,
      ),
    ]);

    if (situation.ok && situation.value && situation.kind) {
      const s = situation.value;
      await safeEvent({
        incident_id: incidentId,
        kind: "situation_updated",
        severity: situationEventSeverity(s),
        title: clip(`Situación: ${s.headline || "informe actualizado"}`, 160),
        detail: clip(
          `${capitalize(TRAPPED_LABEL[s.trapped.status])}. ${s.trapped.basis}`,
          400,
        ),
      });
      await emitContradictionAlerts(incidentId, s, incident.situation);
    }
    if (scene.ok && scene.value && scene.kind) {
      await safeEvent({
        incident_id: incidentId,
        kind: "scene_updated",
        severity: "info",
        title: "Reconstrucción de la escena actualizada",
        detail: clip(scene.value.description, 400),
      });
    }
    return situation.ok && scene.ok;
  }

  async function emitContradictionAlerts(
    incidentId: string,
    current: SituationReport,
    previous: SituationReport | null,
  ): Promise<void> {
    const known = new Set((previous?.contradictions ?? []).map(contradictionKey));
    const fresh = current.contradictions.filter((c) => !known.has(contradictionKey(c)));
    if (!fresh.length) return;
    const existing = await existingEventKeys(incidentId);
    for (const c of fresh) {
      const sources = c.sources.filter((s) => s.trim()).join(" · ");
      const title = clip(`Contradicción entre fuentes${sources ? `: ${sources}` : ""}`, 160);
      const key = `alert\n\n${title}`;
      if (existing.has(key)) continue;
      existing.add(key);
      await safeEvent({
        incident_id: incidentId,
        kind: "alert",
        severity: "warning",
        title,
        detail: clip(c.description, 400),
      });
    }
  }

  async function requestFusionInner(incidentId: string, force: boolean): Promise<void> {
    if (!engine) return;
    const incident = await store.getIncident(incidentId);
    if (!incident) {
      console.error("[pipeline] incidente inexistente al pedir fusión", incidentId);
      return;
    }
    await store.updateIncident(incidentId, {
      pipeline: {
        fusion_requested_at: nowIso(),
        ...(incident.pipeline.fusion_status === "running" ? {} : { fusion_status: "pending" as const }),
      },
    });
    if (!(await store.acquireLock(incidentId, "fusion", LOCK_TTL_S))) {
      // Otra invocación está fusionando: verá el fusion_requested_at nuevo y dará otra vuelta.
      return;
    }
    let allOk = true;
    let ran = false;
    try {
      if (!force) {
        const [mediaList, comms] = await Promise.all([
          store.listMedia(incidentId),
          store.listComms(incidentId),
        ]);
        if (mediaList.length === 0 && comms.length === 0) {
          // Sin fuentes no hay nada que fusionar; con force se corre igual.
          await safePipelinePatch(incidentId, { fusion_status: "idle", fusion_finished_at: nowIso() });
          return;
        }
      }
      for (let round = 1; round <= MAX_ROUNDS; round++) {
        const startedAt = nowIso();
        ran = true;
        allOk = await fusionRound(incidentId, startedAt);
        const latest = await store.getIncident(incidentId);
        if (!latest) return;
        const requested = ms(latest.pipeline.fusion_requested_at);
        if (!(requested > ms(startedAt))) break;
        if (round === MAX_ROUNDS) {
          console.error("[pipeline] fusión: se alcanzó el máximo de vueltas con pedidos pendientes", incidentId);
        }
      }
    } catch (err) {
      allOk = false;
      console.error("[pipeline] falló la fusión", incidentId, err);
      recordServerError("analisis", err, { incidentId, context: "Falló la fusión" });
      await safePipelinePatch(incidentId, { fusion_error: `Falló la fusión: ${errorMessage(err)}` });
      await safeEvent({
        incident_id: incidentId,
        kind: "error",
        severity: "warning",
        title: "Falló la actualización del informe",
        detail: clip(errorMessage(err), 400),
      });
    } finally {
      if (ran || !allOk) {
        await safePipelinePatch(incidentId, {
          fusion_status: allOk ? "idle" : "error",
          fusion_finished_at: nowIso(),
        });
      }
      try {
        await store.releaseLock(incidentId, "fusion");
      } catch (err) {
        console.error("[pipeline] no se pudo liberar el candado de fusión", incidentId, err);
      }
    }
  }

  /* ── Comunicaciones ── */

  function commIdForSeq(comms: CommEntry[], seqs: number[]): string | null {
    for (const seq of [...seqs].sort((a, b) => b - a)) {
      const c = comms.find((x) => x.seq === seq);
      if (c) return c.id;
    }
    return null;
  }

  async function emitCommsAlerts(
    incidentId: string,
    current: CommsAnalysis,
    previous: CommsAnalysis | null,
    comms: CommEntry[],
  ): Promise<void> {
    if (current.mayday.active && !previous?.mayday.active) {
      const seqs = current.events.filter((e) => e.kind === "mayday").map((e) => e.entry_seq);
      await safeEvent({
        incident_id: incidentId,
        kind: "comms_alert",
        severity: "critical",
        title: clip(`MAYDAY — ${current.mayday.detail || "bombero en peligro"}`, 160),
        detail: clip(`${current.mayday.detail}`, 400),
        comm_id: commIdForSeq(comms, seqs),
      });
    }
    const prevVictims = previous?.victims.status ?? "unknown";
    if (current.victims.status === "reported" && prevVictims !== "reported") {
      const seqs = [
        ...current.victims.entry_seqs,
        ...current.events.filter((e) => e.kind === "victim_report").map((e) => e.entry_seq),
      ];
      await safeEvent({
        incident_id: incidentId,
        kind: "comms_alert",
        severity: "critical",
        title: clip(`Radio: se informan víctimas — ${current.victims.detail || "sin detalle"}`, 160),
        detail: clip(`${current.victims.detail}`, 400),
        comm_id: commIdForSeq(comms, seqs),
      });
    }
    if (current.victims.status === "denied_by_unit" && prevVictims !== "denied_by_unit") {
      await safeEvent({
        incident_id: incidentId,
        kind: "comms_alert",
        severity: "notice",
        title: "Radio: unidad en el lugar informa que no hay personas atrapadas",
        detail: clip(`${current.victims.detail}`, 400),
        comm_id: commIdForSeq(comms, current.victims.entry_seqs),
      });
    }
  }

  /** Una vuelta de análisis de radio; devuelve si se guardó un análisis y si todo salió bien. */
  async function commsRound(incidentId: string): Promise<{ saved: boolean; ok: boolean }> {
    await store.updateIncident(incidentId, {
      pipeline: { comms_status: "running", comms_error: null },
    });
    const incident = await store.getIncident(incidentId);
    if (!incident) return { saved: false, ok: false };
    // Lo que Vigía dijo por Zello queda en la bitácora, pero no es tráfico de las compañías.
    const comms = (await store.listComms(incidentId)).filter((c) => !isVigiaVoiceComm(c));
    if (comms.length === 0) return { saved: false, ok: true };
    const previous = incident.comms_analysis;
    const input: CommsAnalysisInput = {
      incident: toIncidentContext(incident),
      comms,
      previous,
      now: nowIso(),
    };

    if (!engine) return { saved: false, ok: true };
    let analysis: CommsAnalysis;
    const kind: AnalysisEngine = engine.kind;
    const recordError = async (err: unknown, title: string) => {
      await safePipelinePatch(incidentId, { comms_error: errorMessage(err) });
      await safeEvent({
        incident_id: incidentId,
        kind: "error",
        severity: "warning",
        title,
        detail: clip(errorMessage(err), 400),
      });
    };
    try {
      analysis = await engine.analyzeComms(input);
    } catch (err) {
      console.error("[pipeline] falló el análisis de comunicaciones", incidentId, err);
      await recordError(err, "Falló el análisis de radio");
      return { saved: false, ok: false };
    }

    await store.updateIncident(incidentId, {
      comms_analysis: analysis,
      comms_engine: kind,
      comms_analysis_updated_at: nowIso(),
    });
    await emitCommsAlerts(incidentId, analysis, previous, comms);
    return { saved: true, ok: true };
  }

  async function requestCommsInner(incidentId: string): Promise<void> {
    if (!engine) return;
    const incident = await store.getIncident(incidentId);
    if (!incident) {
      console.error("[pipeline] incidente inexistente al pedir análisis de radio", incidentId);
      return;
    }
    await store.updateIncident(incidentId, {
      pipeline: {
        comms_requested_at: nowIso(),
        ...(incident.pipeline.comms_status === "running" ? {} : { comms_status: "pending" as const }),
      },
    });
    if (!(await store.acquireLock(incidentId, "comms", LOCK_TTL_S))) return;
    let anySaved = false;
    let allOk = true;
    try {
      for (let round = 1; round <= MAX_ROUNDS; round++) {
        const startedAt = nowIso();
        const r = await commsRound(incidentId);
        anySaved ||= r.saved;
        allOk = r.ok;
        const latest = await store.getIncident(incidentId);
        if (!latest) break;
        if (!(ms(latest.pipeline.comms_requested_at) > ms(startedAt))) break;
      }
    } catch (err) {
      allOk = false;
      console.error("[pipeline] falló el análisis de comunicaciones", incidentId, err);
      await safePipelinePatch(incidentId, { comms_error: errorMessage(err) });
      await safeEvent({
        incident_id: incidentId,
        kind: "error",
        severity: "warning",
        title: "Falló el análisis de radio",
        detail: clip(errorMessage(err), 400),
      });
    } finally {
      await safePipelinePatch(incidentId, {
        comms_status: allOk ? "idle" : "error",
        comms_finished_at: nowIso(),
      });
      try {
        await store.releaseLock(incidentId, "comms");
      } catch (err) {
        console.error("[pipeline] no se pudo liberar el candado de radio", incidentId, err);
      }
    }
    if (anySaved) await requestFusionInner(incidentId, false);
  }

  /* ── Envolturas que nunca lanzan ── */

  return {
    async processMedia(mediaId, opts) {
      try {
        await processMediaInner(mediaId, opts?.force === true);
      } catch (err) {
        console.error("[pipeline] processMedia falló", mediaId, err);
        try {
          const media = await store.getMedia(mediaId);
          if (media) await failMedia(media, `Falló el procesamiento de ${media.label}: ${errorMessage(err)}`);
        } catch (err2) {
          console.error("[pipeline] no se pudo registrar el fallo del medio", mediaId, err2);
        }
      }
    },
    async requestFusion(incidentId, opts) {
      try {
        await requestFusionInner(incidentId, opts?.force === true);
      } catch (err) {
        console.error("[pipeline] requestFusion falló", incidentId, err);
        await safePipelinePatch(incidentId, {
          fusion_status: "error",
          fusion_error: `Falló la fusión: ${errorMessage(err)}`,
        });
        await safeEvent({
          incident_id: incidentId,
          kind: "error",
          severity: "warning",
          title: "Falló la actualización del informe",
          detail: clip(errorMessage(err), 400),
        });
      }
    },
    async requestCommsAnalysis(incidentId) {
      try {
        await requestCommsInner(incidentId);
      } catch (err) {
        console.error("[pipeline] requestCommsAnalysis falló", incidentId, err);
        await safePipelinePatch(incidentId, {
          comms_status: "error",
          comms_error: errorMessage(err),
        });
        await safeEvent({
          incident_id: incidentId,
          kind: "error",
          severity: "warning",
          title: "Falló el análisis de radio",
          detail: clip(errorMessage(err), 400),
        });
      }
    },
  };
}

/* ════════════════════════ Funciones de nivel superior ════════════════════════ */

/**
 * Arma las dependencias reales en cada llamada (getStore/getEngine revisan la
 * configuración cada vez). Import dinámico: evita cargar pg, GCS y el SDK de
 * Anthropic al importar este módulo, y permite probar createPipeline aislado.
 */
async function defaultPipeline(): Promise<Pipeline> {
  const [{ getStore, getFiles }, { getEngine }, { extractFramesOnServer }] =
    await Promise.all([import("@/lib/store"), import("./engine"), import("./server-frames")]);
  const store = getStore();
  const files = getFiles();
  return createPipeline({
    store,
    files,
    engine: getEngine(),
    extractFrames: (media) => extractFramesOnServer(media, { store, files }),
    anchorScene: (incident) => {
      const osm = import("@/lib/osm");
      // Descarga anticipada del entorno (la caché por tesela la reutiliza al anclar).
      void osm.then((m) => m.prefetchOsmContext(incident)).catch(() => undefined);
      // Las cámaras con GPS no se mueven; la escena previa conserva la nota de ajuste.
      return async (scene, media) =>
        (await (await osm).anchorSceneToOsm(scene, incident, { media, previous: incident.scene })).scene;
    },
  });
}

export async function processMedia(mediaId: string, opts?: { force?: boolean }): Promise<void> {
  try {
    await (await defaultPipeline()).processMedia(mediaId, opts);
  } catch (err) {
    console.error("[pipeline] processMedia: no se pudo iniciar el pipeline", mediaId, err);
  }
}

export async function requestFusion(incidentId: string, opts?: { force?: boolean }): Promise<void> {
  try {
    await (await defaultPipeline()).requestFusion(incidentId, opts);
  } catch (err) {
    console.error("[pipeline] requestFusion: no se pudo iniciar el pipeline", incidentId, err);
  }
}

export async function requestCommsAnalysis(incidentId: string): Promise<void> {
  try {
    await (await defaultPipeline()).requestCommsAnalysis(incidentId);
  } catch (err) {
    console.error("[pipeline] requestCommsAnalysis: no se pudo iniciar el pipeline", incidentId, err);
  }
}
