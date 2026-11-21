/**
 * Lo que Vigía tiene a la vista en una emergencia (solo servidor): videos con su análisis
 * y detecciones, radio con claves traducidas, drones y el informe de situación.
 * Se arma en cada vuelta del agente a partir del store; no guarda nada.
 */
import type { LiveInsightView } from "@/lib/contract";
import type { CommEntry, Incident, Media, MediaAnalysis, SituationReport } from "@/lib/domain";
import { isMissionActive } from "@/lib/drone/plan";
import { UNTRANSCRIBED_COMM_TEXT } from "@/lib/labels";
import { getLiveDetections, listLiveInsights } from "@/lib/drone/live";
import { isObacComm, isVigiaVoiceComm } from "@/lib/server/zello/channels";
import { getFiles, getStore } from "@/lib/store";
import { loadMediaDetections } from "@/lib/vision/media-detections";
import type { aggregateDetections, DetectResult } from "@/lib/vision/types";
import { computeCoverage, type SideScheme } from "./coverage";
import { mentionsVigia } from "./rules";
import { expandClaves } from "./radio";
import type { VigiaSideCoverage } from "./types";

export interface WorldMedia {
  id: string;
  label: string;
  source: Media["source"];
  status: Media["status"];
  created_at: string;
  analyzed_at: string | null;
  side: string | null;
  analysis: MediaAnalysis | null;
  note: string;
  /** Resumen de lo que detectó YOLO en el video (null sin detector). */
  detections: ReturnType<typeof aggregateDetections> | null;
}

export interface WorldRadio {
  seq: number;
  at: string;
  speaker: string;
  channel: string;
  text: string;
  /** Texto con las claves traducidas. */
  expanded: string;
  source: CommEntry["source"];
  /** Lo dijo el OBAC hablándole a Vigía (Zello). */
  obac: boolean;
}

export interface WorldDrone {
  mission_id: string;
  label: string;
  active: boolean;
  insights: LiveInsightView[];
  /** Última detección YOLO del video en vivo (null sin detector o sin video). */
  live: { seq: number; at: string; result: DetectResult } | null;
}

export interface World {
  incident: Pick<Incident, "id" | "code" | "title" | "type" | "address" | "status" | "lat" | "lng" | "origin">;
  now: string;
  media: WorldMedia[];
  radio: WorldRadio[];
  drones: WorldDrone[];
  situation: SituationReport | null;
  situation_at: string | null;
  comms_summary: string | null;
  scheme: SideScheme;
  coverage: VigiaSideCoverage[];
  blind: string[];
}

/** Texto útil de una transmisión: ni vacío ni la marca de "sin transcribir". */
export function hasContent(text: string): boolean {
  const t = text.trim();
  return t !== "" && t !== UNTRANSCRIBED_COMM_TEXT;
}

/**
 * La transmisión de Zello es una pregunta para Vigía: la regla del puente (usuario del OBAC
 * o «Vigía, …» al inicio) o el vocativo como suele transcribirse («Viking», «vigila»…).
 */
export function isObacQuestion(c: Pick<CommEntry, "source" | "speaker" | "text">): boolean {
  return isObacComm(c) || (c.source === "zello" && mentionsVigia(c.text));
}

/** Las transmisiones de Vigía por Zello vuelven a la bitácora: no se escucha a sí misma. */
export function isVigiaSpeaker(speaker: string): boolean {
  return /^\s*vig[ií]a\b/i.test(speaker);
}

type GlobalWithDetCache = typeof globalThis & { __vigiaMediaDetections?: Map<string, WorldMedia["detections"]> };

/** Las detecciones de un video no cambian después del análisis: se leen una vez por proceso. */
async function mediaDetections(incidentId: string, m: Media): Promise<WorldMedia["detections"]> {
  if (m.status !== "analyzed") return null;
  const g = globalThis as GlobalWithDetCache;
  g.__vigiaMediaDetections ??= new Map();
  const key = `${m.id}:${m.analyzed_at ?? ""}`;
  if (g.__vigiaMediaDetections.has(key)) return g.__vigiaMediaDetections.get(key) ?? null;
  const d = await loadMediaDetections(getFiles(), incidentId, m.id);
  const agg = d ? d.aggregate : null;
  g.__vigiaMediaDetections.set(key, agg);
  return agg;
}

export async function loadWorld(incidentId: string): Promise<World | null> {
  const store = getStore();
  const incident = await store.getIncident(incidentId);
  if (!incident) return null;
  const [media, comms, missions] = await Promise.all([
    store.listMedia(incidentId),
    store.listComms(incidentId),
    store.listMissions(incidentId),
  ]);
  const cov = computeCoverage(incident, media);
  const detections = await Promise.all(media.map((m) => mediaDetections(incidentId, m)));
  const detById = new Map(media.map((m, i) => [m.id, detections[i]]));
  return {
    incident: {
      id: incident.id,
      code: incident.code,
      title: incident.title,
      type: incident.type,
      address: incident.address,
      status: incident.status,
      lat: incident.lat,
      lng: incident.lng,
      origin: incident.origin,
    },
    now: new Date().toISOString(),
    media: media
      .slice()
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((m) => ({
        id: m.id,
        label: m.label,
        source: m.source,
        status: m.status,
        created_at: m.created_at,
        analyzed_at: m.analyzed_at,
        side: cov.sideOf[m.label] ?? null,
        analysis: m.analysis,
        note: m.reporter_note,
        detections: detById.get(m.id) ?? null,
      })),
    radio: comms
      // Ni lo que dijo Vigía ni las transmisiones sin texto (toques del PTT, ruido): no aportan y hacían
      // que Vigía hablara de ellas en vez de responder.
      .filter((c) => !isVigiaVoiceComm(c) && !isVigiaSpeaker(c.speaker) && hasContent(c.text))
      .sort((a, b) => a.seq - b.seq)
      .map((c) => ({
        seq: c.seq,
        at: c.at,
        speaker: c.speaker,
        channel: c.channel,
        text: c.text,
        expanded: expandClaves(c.text),
        source: c.source,
        obac: isObacQuestion(c),
      })),
    drones: missions.map((m) => ({
      mission_id: m.id,
      label: m.label,
      active: isMissionActive(m),
      insights: listLiveInsights(m.id).insights,
      live: isMissionActive(m) ? getLiveDetections(m.id) : null,
    })),
    situation: incident.situation,
    situation_at: incident.situation_updated_at,
    comms_summary: incident.comms_analysis?.summary ?? null,
    scheme: cov.scheme,
    coverage: cov.coverage,
    blind: cov.blind,
  };
}

/* ───────────────────────────── Lectura para el agente ───────────────────────────── */

/** Videos que ya se pueden usar (analizados y utilizables). */
export function analyzedMedia(world: World): WorldMedia[] {
  return world.media.filter((m) => m.status === "analyzed" && m.analysis?.usable !== false);
}

/** Radios que escucha: emisores distintos (unidades y Central) en la emergencia, sin el OBAC hablándole a Vigía. */
export function activeRadios(world: World): number {
  const speakers = new Set(
    world.radio.filter((r) => !r.obac && r.speaker.trim() !== "").map((r) => r.speaker.trim().toUpperCase()),
  );
  return speakers.size;
}

const PERSON_STATUSES = new Set(["trapped", "at_window_or_balcony", "on_roof", "injured", "unknown"]);

export interface PersonSighting {
  media: string;
  side: string | null;
  location: string;
  floor: number;
  count: number;
  status: string;
  confidence: string;
}

/** Personas relevantes vistas en los videos (sin testigos ni personal de emergencia). */
export function personSightings(world: World): PersonSighting[] {
  const out: PersonSighting[] = [];
  for (const m of analyzedMedia(world)) {
    for (const p of m.analysis?.people ?? []) {
      if (!PERSON_STATUSES.has(p.status)) continue;
      out.push({
        media: m.label,
        side: m.side,
        location: p.location,
        floor: p.floor,
        count: p.count,
        status: p.status,
        confidence: p.confidence,
      });
    }
  }
  return out;
}
