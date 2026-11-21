/**
 * Resolución de referencias de evidencia ("M3" + fotograma, "C12") contra los medios
 * y comunicaciones del incidente. Lógica pura, sin renderizado (se prueba aparte).
 */
import type { CommEntry, EvidenceRef } from "@/lib/domain";
import type { MediaView } from "@/lib/contract";

/** Qué tipo de fuente nombra una referencia según su etiqueta. */
export type EvidenceKind = "media" | "comm" | "unknown";

/**
 * Estado de una referencia:
 *  - `available`: la fuente existe y se puede abrir.
 *  - `missing`: la fuente no existe (etiqueta inventada o borrada): se muestra atenuada y sin acción.
 *  - `unchecked`: no hay listas para verificarla (franja crítica); se puede abrir si la etiqueta es válida.
 */
export type EvidenceState = "available" | "missing" | "unchecked";

export interface ResolvedEvidence {
  ref: EvidenceRef;
  kind: EvidenceKind;
  /** Texto del chip: "M2 · cuadro 3", "M2", "C7". */
  label: string;
  state: EvidenceState;
  /** Miniatura del fotograma citado (o póster si no cita fotograma); null si no hay. */
  thumbUrl: string | null;
  /** Texto de ayuda (title/aria): qué muestra la fuente o por qué no está disponible. */
  description: string;
}

const MEDIA_RE = /^M(\d+)$/i;
const COMM_RE = /^C(\d+)$/i;

/** Normaliza la etiqueta ("m3 " → "M3"). */
export function normalizeRefLabel(ref: string): string {
  return ref.trim().toUpperCase();
}

/** Tipo de fuente que nombra la etiqueta. */
export function evidenceKind(ref: string): EvidenceKind {
  const label = normalizeRefLabel(ref);
  if (MEDIA_RE.test(label)) return "media";
  if (COMM_RE.test(label)) return "comm";
  return "unknown";
}

/** Índice de fotograma válido (entero ≥ 0) o null si la referencia no cita fotograma. */
export function frameIndex(ref: EvidenceRef): number | null {
  return Number.isInteger(ref.frame) && ref.frame >= 0 ? ref.frame : null;
}

/** Texto del chip; el índice de cuadro es el mismo que cita la IA (0 = primero). */
export function evidenceLabel(ref: EvidenceRef): string {
  const label = normalizeRefLabel(ref.ref) || "?";
  const idx = frameIndex(ref);
  return evidenceKind(label) === "media" && idx !== null ? `${label} · cuadro ${idx}` : label;
}

/** Fuentes contra las que se verifica una referencia; ausentes = no se verifica. */
export interface EvidenceSources {
  media?: readonly MediaView[];
  comms?: readonly CommEntry[];
}

/** Resuelve una referencia: si existe su fuente, su miniatura y el texto de ayuda. */
export function resolveEvidence(ref: EvidenceRef, sources: EvidenceSources = {}): ResolvedEvidence {
  const label = evidenceLabel(ref);
  const norm = normalizeRefLabel(ref.ref);
  const kind = evidenceKind(norm);
  const note = ref.note.trim();

  if (kind === "unknown") {
    return {
      ref,
      kind,
      label,
      state: "missing",
      thumbUrl: null,
      description: `Referencia no reconocida: ${norm || "sin etiqueta"}`,
    };
  }

  if (kind === "media") {
    if (!sources.media) {
      return { ref, kind, label, state: "unchecked", thumbUrl: null, description: note || `Abrir ${label}` };
    }
    const media = sources.media.find((m) => normalizeRefLabel(m.label) === norm);
    if (!media) {
      return { ref, kind, label, state: "missing", thumbUrl: null, description: `${norm} no está entre los medios recibidos` };
    }
    const idx = frameIndex(ref);
    const frame = idx === null ? undefined : media.urls.frames.find((f) => f.idx === idx);
    const thumbUrl = frame ? frame.url : idx === null ? media.urls.poster : null;
    const frameNote = idx !== null && !frame ? ` (el cuadro ${idx} no está disponible)` : "";
    return {
      ref,
      kind,
      label,
      state: "available",
      thumbUrl,
      description: `${note || `Abrir ${label}`}${frameNote}`,
    };
  }

  if (!sources.comms) {
    return { ref, kind, label, state: "unchecked", thumbUrl: null, description: note || `Ver ${label} en la bitácora` };
  }
  const seq = Number(COMM_RE.exec(norm)?.[1]);
  const entry = sources.comms.find((c) => c.seq === seq);
  if (!entry) {
    return { ref, kind, label, state: "missing", thumbUrl: null, description: `${norm} no está en la bitácora` };
  }
  const said = entry.speaker ? `${entry.speaker}: ${entry.text}` : entry.text;
  return { ref, kind, label, state: "available", thumbUrl: null, description: note || said };
}

/** Convierte las etiquetas de una contradicción (["M2","C7"]) en referencias sin fotograma. */
export function refsFromLabels(labels: readonly string[]): EvidenceRef[] {
  return labels.map((ref) => ({ ref, frame: -1, note: "" }));
}
