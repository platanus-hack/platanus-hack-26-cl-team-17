/**
 * Motor de IA con Claude (visión + salida estructurada). Solo servidor.
 *
 * Cada tarea usa su prompt de sistema estable (cacheable) y un mensaje de
 * usuario armado por prompts.ts. Después de validar el esquema se hace una
 * post-validación barata y segura: se quitan referencias a fotogramas o
 * fuentes que no existen en la entrada y se impide un "sin atrapados" que no
 * cite la radio. Nunca se inventa contenido ni se rebaja el estado de víctimas.
 * La escena se devuelve cruda: el pipeline aplica sanitizeScene a toda escena.
 */
import {
  CommsAnalysisAISchema,
  MediaAnalysisAISchema,
  SceneModelAISchema,
  SituationReportAISchema,
  type CommsAnalysis,
  type EvidenceRef,
  type MediaAnalysis,
  type PersonStatus,
  type SceneModel,
  type SituationReport,
} from "@/lib/domain";
import { callStructured } from "./client";
import {
  COMMS_SYSTEM_PROMPT,
  MEDIA_SYSTEM_PROMPT,
  SCENE_SYSTEM_PROMPT,
  SITUATION_SYSTEM_PROMPT,
  buildCommsUserContent,
  buildFusionUserContent,
  buildMediaUserContent,
} from "./prompts";
import type { CommsAnalysisInput, Engine, FusionInput, MediaAnalysisInput } from "./types";

/**
 * Los esquemas de medio, informe y escena superan el límite del compilador de
 * gramáticas de la salida estructurada (400 medido con claude-opus-5-5): van
 * directo en modo prompt (esquema en el sistema + validación Zod + una corrección).
 */
const LARGE_SCHEMA_MODE = "prompt" as const;

export function createClaudeEngine(): Engine {
  return {
    kind: "claude",

    async analyzeMedia(input: MediaAnalysisInput): Promise<MediaAnalysis> {
      // Sin fotogramas igual se llama: el contenido trae la nota del vecino y los metadatos.
      const raw = await callStructured({
        task: "media",
        system: MEDIA_SYSTEM_PROMPT,
        content: buildMediaUserContent(input),
        schema: MediaAnalysisAISchema,
        mode: LARGE_SCHEMA_MODE,
      });
      return postMediaAnalysis(raw, input);
    },

    async analyzeComms(input: CommsAnalysisInput): Promise<CommsAnalysis> {
      const raw = await callStructured({
        task: "comms",
        system: COMMS_SYSTEM_PROMPT,
        content: buildCommsUserContent(input),
        schema: CommsAnalysisAISchema,
      });
      return postCommsAnalysis(raw, input);
    },

    async fuseSituation(input: FusionInput): Promise<SituationReport> {
      const raw = await callStructured({
        task: "situation",
        system: SITUATION_SYSTEM_PROMPT,
        content: buildFusionUserContent(input, "situation"),
        schema: SituationReportAISchema,
        mode: LARGE_SCHEMA_MODE,
      });
      return postSituation(raw, input);
    },

    async fuseScene(input: FusionInput): Promise<SceneModel> {
      const raw = await callStructured({
        task: "scene",
        system: SCENE_SYSTEM_PROMPT,
        content: buildFusionUserContent(input, "scene"),
        schema: SceneModelAISchema,
        mode: LARGE_SCHEMA_MODE,
      });
      return postScene(raw, input);
    },
  };
}

/* ═══════════════════════ Post-validación (pura) ═══════════════════════ */

function uniqueValid(refs: readonly number[], valid: ReadonlySet<number>): number[] {
  const out: number[] = [];
  for (const r of refs) {
    if (valid.has(r) && !out.includes(r)) out.push(r);
  }
  return out;
}

/** Conteo entero no negativo; redondea hacia arriba para no achicar nunca una cantidad de personas. */
function nonNegativeCount(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : 0;
}

const NO_FRAMES_NOTE = "No se recibieron fotogramas de este medio: el análisis se basa solo en la nota y los metadatos.";

/** Deja solo índices de fotograma que existen en la entrada. No toca estados ni personas. */
export function postMediaAnalysis(analysis: MediaAnalysis, input: MediaAnalysisInput): MediaAnalysis {
  const valid = new Set(input.frames.map((f) => f.idx));
  const seenKey = new Set<number>();
  const key_frames = analysis.key_frames.filter((k) => {
    if (!valid.has(k.frame) || seenKey.has(k.frame)) return false;
    seenKey.add(k.frame);
    return true;
  });
  const uncertainties = [...analysis.uncertainties];
  if (input.frames.length === 0 && !uncertainties.includes(NO_FRAMES_NOTE)) {
    uncertainties.unshift(NO_FRAMES_NOTE);
  }
  return {
    ...analysis,
    people: analysis.people.map((p) => ({ ...p, frame_refs: uniqueValid(p.frame_refs, valid) })),
    vehicles: analysis.vehicles.map((v) => ({ ...v, frame_refs: uniqueValid(v.frame_refs, valid) })),
    hazards: analysis.hazards.map((h) => ({ ...h, frame_refs: uniqueValid(h.frame_refs, valid) })),
    key_frames,
    uncertainties,
  };
}

export const UNCITED_DENIAL_NOTE =
  "Se dejó como desconocido: el modelo indicó que no hay víctimas pero no citó la entrada radial de una unidad en el lugar que lo respalde.";

/**
 * Referencias a entradas de radio que no existen → fuera (los hechos se
 * conservan con entry_seq -1). "denied_by_unit" sin entrada citada → "unknown"
 * (más cauteloso, nunca menos).
 */
export function postCommsAnalysis(analysis: CommsAnalysis, input: CommsAnalysisInput): CommsAnalysis {
  const seqs = new Set(input.comms.map((c) => c.seq));
  const entry_seqs = uniqueValid(analysis.victims.entry_seqs, seqs);
  let victims = { ...analysis.victims, entry_seqs };
  if (victims.status === "denied_by_unit" && entry_seqs.length === 0) {
    victims = {
      ...victims,
      status: "unknown",
      detail: victims.detail ? `${victims.detail} (${UNCITED_DENIAL_NOTE})` : UNCITED_DENIAL_NOTE,
    };
  }
  return {
    ...analysis,
    events: analysis.events.map((e) => (seqs.has(e.entry_seq) ? e : { ...e, entry_seq: -1 })),
    victims,
  };
}

/** Etiquetas citables en la fusión: "M<n>" → índices de fotograma conocidos; "C<seq>" → sin fotograma. */
interface FusionRefIndex {
  media: Map<string, Set<number>>;
  comms: Set<string>;
}

function fusionRefIndex(input: FusionInput): FusionRefIndex {
  const media = new Map<string, Set<number>>();
  for (const fm of input.media) {
    const frames = new Set(fm.media.frames.map((f) => f.idx));
    for (const kf of input.keyFrames) if (kf.media_label === fm.media.label) frames.add(kf.idx);
    media.set(fm.media.label.toUpperCase(), frames);
  }
  const comms = new Set(input.comms.map((c) => `C${c.seq}`));
  return { media, comms };
}

function normalizeLabel(ref: string): string {
  return ref.trim().toUpperCase();
}

function isKnownLabel(label: string, idx: FusionRefIndex): boolean {
  return idx.media.has(label) || idx.comms.has(label);
}

/** Quita evidencias de fuentes que no están en la entrada; fotograma inexistente → -1. */
function cleanEvidence(refs: readonly EvidenceRef[], idx: FusionRefIndex): EvidenceRef[] {
  const out: EvidenceRef[] = [];
  for (const r of refs) {
    const label = normalizeLabel(r.ref);
    const frames = idx.media.get(label);
    if (frames) {
      out.push({ ...r, ref: label, frame: frames.has(r.frame) ? r.frame : -1 });
    } else if (idx.comms.has(label)) {
      out.push({ ...r, ref: label, frame: -1 });
    }
  }
  return out;
}

export const UNCITED_CLEARANCE_NOTE =
  "Sin respaldo radial citado de una unidad en el lugar: no se puede dar por descartado. Ausencia de evidencia no descarta víctimas.";

export function postSituation(report: SituationReport, input: FusionInput): SituationReport {
  const idx = fusionRefIndex(input);
  const trappedEvidence = cleanEvidence(report.trapped.evidence, idx);
  let trapped = {
    ...report.trapped,
    count_min: nonNegativeCount(report.trapped.count_min),
    count_max: nonNegativeCount(report.trapped.count_max),
    evidence: trappedEvidence,
  };
  // cleared_by_unit solo vale si se cita una entrada de radio existente.
  if (trapped.status === "cleared_by_unit" && !trappedEvidence.some((e) => idx.comms.has(e.ref))) {
    trapped = {
      ...trapped,
      status: "no_evidence",
      basis: trapped.basis ? `${trapped.basis} (${UNCITED_CLEARANCE_NOTE})` : UNCITED_CLEARANCE_NOTE,
    };
  }
  return {
    ...report,
    trapped,
    injured: { ...report.injured, count_estimate: nonNegativeCount(report.injured.count_estimate) },
    vehicles: { ...report.vehicles, count: nonNegativeCount(report.vehicles.count) },
    hazards: report.hazards.map((h) => ({ ...h, evidence: cleanEvidence(h.evidence, idx) })),
    insights: report.insights.map((i) => ({ ...i, evidence: cleanEvidence(i.evidence, idx) })),
    contradictions: report.contradictions.map((c) => ({
      ...c,
      sources: [...new Set(c.sources.map(normalizeLabel))].filter((s) => isKnownLabel(s, idx)),
    })),
  };
}

/** Solo limpia evidencias de personas; la geometría la sanea sanitizeScene en el pipeline. */
const AT_RISK_STATUSES: ReadonlySet<PersonStatus> = new Set<PersonStatus>([
  "trapped",
  "at_window_or_balcony",
  "on_roof",
  "injured",
]);
const STATUS_RANK: Record<PersonStatus, number> = {
  trapped: 0,
  at_window_or_balcony: 1,
  on_roof: 2,
  injured: 3,
  unknown: 4,
  evacuating: 5,
  bystander: 6,
  responder: 7,
};
const REPORTED_PERSON_NOTE =
  "Marcador agregado por el sistema: una fuente informa a esta persona y la reconstrucción no la ubicó. Ubicación aproximada, no informada con precisión.";

function isAtRisk(status: PersonStatus, count: number): boolean {
  return AT_RISK_STATUSES.has(status) || (status === "unknown" && count > 0);
}

/**
 * Si un análisis o la radio informan personas en riesgo y la escena no trae
 * ninguna, agrega UN marcador (sin duplicar conteos) en la estructura afectada
 * con confianza baja. La escena nunca debe "perder" a una persona reportada.
 */
export function ensureReportedPeople(scene: SceneModel, input: FusionInput): SceneModel["people"] {
  if (scene.people.some((p) => isAtRisk(p.status, p.count))) return scene.people;

  let status: PersonStatus | null = null;
  let count = 0;
  let floor = 0;
  const evidence: EvidenceRef[] = [];
  const locations: string[] = [];
  for (const fm of input.media) {
    for (const p of fm.analysis?.people ?? []) {
      if (!isAtRisk(p.status, p.count)) continue;
      if (status === null || STATUS_RANK[p.status] < STATUS_RANK[status]) status = p.status;
      count = Math.max(count, nonNegativeCount(p.count), 1);
      if (floor === 0 && p.floor > 0) floor = Math.round(p.floor);
      if (p.location) locations.push(`${fm.media.label}: ${p.location}`);
      evidence.push({ ref: fm.media.label, frame: p.frame_refs[0] ?? -1, note: p.description || p.location });
    }
  }
  const victims = input.commsAnalysis?.victims;
  if (victims?.status === "reported") {
    status ??= "unknown";
    count = Math.max(count, 1);
    if (victims.detail) locations.push(`Radio: ${victims.detail}`);
    for (const seq of victims.entry_seqs.slice(0, 3)) {
      evidence.push({ ref: `C${seq}`, frame: -1, note: victims.detail });
    }
  }
  if (status === null) return scene.people;

  const structure = scene.structures.find((st) => st.role === "involved") ?? scene.structures[0] ?? null;
  const floorHeight = structure && structure.floor_height_m > 0 ? structure.floor_height_m : 2.7;
  const usedIds = new Set(scene.people.map((p) => p.id));
  let n = scene.people.length + 1;
  while (usedIds.has(`P${n}`)) n++;
  return [
    ...scene.people,
    {
      id: `P${n}`,
      status,
      count,
      structure_id: structure?.id ?? "",
      floor,
      x: structure?.x ?? 0,
      y: structure?.y ?? 0,
      z: floor > 0 ? (floor - 1) * floorHeight + 1.5 : 0,
      confidence: "low",
      note: [REPORTED_PERSON_NOTE, ...locations].join(" ").slice(0, 600),
      evidence: evidence.slice(0, 6),
    },
  ];
}

export function postScene(scene: SceneModel, input: FusionInput): SceneModel {
  const idx = fusionRefIndex(input);
  const cleaned: SceneModel = {
    ...scene,
    people: scene.people.map((p) => ({ ...p, evidence: cleanEvidence(p.evidence, idx) })),
  };
  return { ...cleaned, people: ensureReportedPeople(cleaned, input) };
}
