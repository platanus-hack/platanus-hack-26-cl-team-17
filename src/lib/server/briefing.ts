/**
 * Briefing en ruta (servidor): vista de solo lectura para la tablet del carro,
 * abierta con la clave del enlace (`?k=<share_key>`) y sin sesión.
 *
 * Nunca expone `share_key` (salvo dentro de las URLs de archivos, que ya la
 * llevan por diseño), notas de vecinos ni datos del personal.
 */
import type { BriefingSnapshot, RuntimeMode, UnchangedResponse } from "@/lib/contract";
import type { EvidenceRef, Incident, Media, MediaFrame, SituationReport } from "@/lib/domain";
import { errors } from "@/lib/http";
import { safeEqual } from "@/lib/ids";
import type { Store } from "@/lib/store/types";
import { fileUrl } from "./snapshot";

export const MAX_BRIEFING_KEY_FRAMES = 6;
const MAX_CAPTION_CHARS = 180;

/** Mismo mensaje para "no existe" y "clave incorrecta": no revela qué incidentes existen. */
export const BRIEFING_NOT_FOUND = "Este enlace de briefing no es válido. Pide uno nuevo al puesto de mando.";

type KeyFrame = BriefingSnapshot["key_frames"][number];

function clip(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** Cuadro citado: el índice exacto; con -1 (sin cuadro) el primer fotograma clave o el primero. */
function resolveFrame(media: Media, frame: number): MediaFrame | null {
  const frames = [...media.frames].sort((a, b) => a.idx - b.idx);
  if (frames.length === 0) return null;
  if (frame >= 0) return frames.find((f) => f.idx === frame) ?? null;
  const key = media.analysis?.key_frames?.[0]?.frame;
  return (key === undefined ? undefined : frames.find((f) => f.idx === key)) ?? frames[0];
}

const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 } as const;

/**
 * Hasta 6 fotogramas clave para el carro, en orden de importancia:
 *  1. evidencia de personas atrapadas;
 *  2. evidencia de hallazgos críticos;
 *  3. evidencia de peligros altos;
 *  4. evidencia de hallazgos de prioridad alta;
 *  5. fotogramas clave del análisis de cada medio;
 *  6. el primer fotograma de cada medio que aún no aparece (si quedan cupos).
 * Las referencias a comunicaciones ("C<n>") se omiten: no tienen imagen.
 */
export function selectKeyFrames(
  situation: SituationReport | null,
  media: Media[],
  shareKey: string | null,
): KeyFrame[] {
  // Los medios que aún suben pueden no tener sus cuadros en el storage.
  const usable = media.filter((m) => m.status !== "uploading" && m.frames.length > 0);
  const byLabel = new Map(usable.map((m) => [m.label.trim().toUpperCase(), m]));
  const out: KeyFrame[] = [];
  const seen = new Set<string>();
  const shown = new Set<string>();

  const push = (m: Media | undefined, frameIdx: number, caption: string) => {
    if (!m || out.length >= MAX_BRIEFING_KEY_FRAMES) return;
    const f = resolveFrame(m, frameIdx);
    if (!f) return;
    const key = `${m.id}:${f.idx}`;
    if (seen.has(key)) return;
    seen.add(key);
    shown.add(m.id);
    out.push({
      media_label: m.label,
      frame: f.idx,
      url: fileUrl(f.storage_path, shareKey),
      caption: clip(caption || `Imagen de ${m.label}`, MAX_CAPTION_CHARS),
    });
  };
  const pushRefs = (refs: EvidenceRef[], fallback: string) => {
    for (const r of refs) push(byLabel.get(r.ref.trim().toUpperCase()), r.frame, r.note.trim() || fallback);
  };

  if (situation) {
    pushRefs(situation.trapped.evidence, situation.trapped.basis.trim() || "Evidencia sobre personas atrapadas");
    const insights = [...situation.insights].sort(
      (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority],
    );
    for (const i of insights.filter((x) => x.priority === "critical")) pushRefs(i.evidence, i.title);
    for (const h of situation.hazards.filter((x) => x.severity === "high")) pushRefs(h.evidence, h.description);
    for (const i of insights.filter((x) => x.priority === "high")) pushRefs(i.evidence, i.title);
  }
  // Primero el fotograma clave principal de cada medio, después los demás.
  const sorted = [...usable].sort((a, b) => labelNumber(a.label) - labelNumber(b.label));
  for (const m of sorted) {
    const k = m.analysis?.key_frames?.[0];
    if (k) push(m, k.frame, k.caption);
  }
  for (const m of sorted) {
    for (const k of m.analysis?.key_frames?.slice(1) ?? []) push(m, k.frame, k.caption);
  }
  for (const m of sorted) {
    if (!shown.has(m.id)) push(m, Math.min(...m.frames.map((f) => f.idx)), m.analysis?.summary ?? "");
  }
  return out;
}

function labelNumber(label: string): number {
  const n = Number(/\d+/.exec(label)?.[0]);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

export function pickBriefingIncident(incident: Incident): BriefingSnapshot["incident"] {
  return {
    id: incident.id,
    code: incident.code,
    type: incident.type,
    title: incident.title,
    address: incident.address,
    lat: incident.lat,
    lng: incident.lng,
    status: incident.status,
    verified: incident.verified,
    rev: incident.rev,
    created_at: incident.created_at,
    situation_updated_at: incident.situation_updated_at,
    situation_engine: incident.situation_engine,
    scene_engine: incident.scene_engine,
  };
}

export function buildBriefing(incident: Incident, media: Media[], mode: RuntimeMode, now: Date): BriefingSnapshot {
  return {
    incident: pickBriefingIncident(incident),
    situation: incident.situation,
    scene: incident.scene,
    key_frames: selectKeyFrames(incident.situation, media, incident.share_key),
    media_count: media.length,
    mode,
    server_time: now.toISOString(),
  };
}

export interface BriefingRequest {
  /** `?k=` del enlace; si viene, debe calzar aunque haya sesión. */
  key: string | null;
  rev: number | null;
  /** Solo se consulta sin clave: el personal con sesión puede abrir el briefing sin el enlace. */
  hasStaffSession: () => Promise<boolean>;
  mode: RuntimeMode;
  now?: Date;
}

/** 404 si el incidente no existe, la clave no calza o falta la clave sin sesión de personal. */
export async function loadBriefing(
  store: Store,
  id: string,
  req: BriefingRequest,
): Promise<BriefingSnapshot | UnchangedResponse> {
  const now = req.now ?? new Date();
  const incident = await store.getIncident(id);
  if (!incident) throw errors.notFound(BRIEFING_NOT_FOUND);
  if (req.key !== null) {
    if (!safeEqual(req.key, incident.share_key)) throw errors.notFound(BRIEFING_NOT_FOUND);
  } else if (!(await req.hasStaffSession())) {
    throw errors.notFound(BRIEFING_NOT_FOUND);
  }
  if (req.rev !== null && req.rev === incident.rev) {
    return { unchanged: true, rev: incident.rev, server_time: now.toISOString() };
  }
  const media = await store.listMedia(id);
  return buildBriefing(incident, media, req.mode, now);
}
