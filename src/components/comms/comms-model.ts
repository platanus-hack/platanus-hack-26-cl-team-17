/**
 * Lógica pura del panel de comunicaciones: orden de la bitácora, etiquetas de eventos
 * por entrada, sugerencias de emisor y canal. Sin React; probado en comms-model.test.ts.
 */
import type { CommEntry, CommEventKind, CommSource, CommsAnalysis } from "@/lib/domain";
import type { Tone } from "@/components/ui";

/** Origen de la entrada en forma breve, tal como se muestra en cada línea de la bitácora. */
export const commSourceShort: Record<CommSource, string> = {
  manual: "manual",
  dictation: "dictado",
  simulated: "simulado",
  import: "importado",
  zello: "Zello",
};

/** Etiqueta que el análisis pone sobre una entrada de la bitácora. */
export interface EntryTag {
  key: string;
  label: string;
  tone: Tone;
  kind: CommEventKind | "victims_denied";
}

/** Solo estos tipos de evento se marcan en la bitácora (lo que el mando no puede pasar por alto). */
const TAGGED_KINDS: Partial<Record<CommEventKind, { label: string; tone: Tone }>> = {
  mayday: { label: "MAYDAY", tone: "critical" },
  victim_report: { label: "Víctima reportada", tone: "critical" },
  resource_request: { label: "Solicitud de recursos", tone: "warning" },
  hazard: { label: "Peligro", tone: "warning" },
};

const TAG_ORDER: EntryTag["kind"][] = ["mayday", "victim_report", "victims_denied", "resource_request", "hazard"];

/** Etiquetas por `seq` de entrada, a partir de los eventos y del bloque de víctimas del análisis. */
export function tagsBySeq(analysis: CommsAnalysis | null): Map<number, EntryTag[]> {
  const out = new Map<number, EntryTag[]>();
  if (!analysis) return out;
  const add = (seq: number, tag: EntryTag) => {
    if (!Number.isFinite(seq)) return;
    const list = out.get(seq) ?? [];
    if (!list.some((t) => t.kind === tag.kind)) list.push(tag);
    out.set(seq, list);
  };
  for (const ev of analysis.events) {
    const spec = TAGGED_KINDS[ev.kind];
    if (spec) add(ev.entry_seq, { key: ev.kind, label: spec.label, tone: spec.tone, kind: ev.kind });
  }
  for (const seq of analysis.victims.entry_seqs) {
    if (analysis.victims.status === "reported") {
      add(seq, { key: "victim_report", label: "Víctima reportada", tone: "critical", kind: "victim_report" });
    } else if (analysis.victims.status === "denied_by_unit") {
      add(seq, { key: "victims_denied", label: "Unidad: sin atrapados", tone: "ok", kind: "victims_denied" });
    }
  }
  for (const list of out.values()) list.sort((a, b) => TAG_ORDER.indexOf(a.kind) - TAG_ORDER.indexOf(b.kind));
  return out;
}

/** Entradas de radio citadas por los eventos MAYDAY. */
export function maydaySeqs(analysis: CommsAnalysis | null): number[] {
  if (!analysis) return [];
  return uniqueSorted(analysis.events.filter((e) => e.kind === "mayday").map((e) => e.entry_seq));
}

export function uniqueSorted(values: readonly number[]): number[] {
  return [...new Set(values.filter((v) => Number.isFinite(v)))].sort((a, b) => a - b);
}

function time(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

/** Orden cronológico: por hora informada (`at`) y, a igual hora, por `seq`. No modifica la entrada. */
export function sortEntries<T extends Pick<CommEntry, "at" | "seq">>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => time(a.at) - time(b.at) || a.seq - b.seq);
}

/**
 * Une las entradas del snapshot con las que el servidor ya confirmó pero el snapshot
 * aún no trae (sin duplicar por id). El snapshot manda si ambas existen.
 */
export function mergeEntries(fromSnapshot: readonly CommEntry[], confirmed: readonly CommEntry[]): CommEntry[] {
  const ids = new Set(fromSnapshot.map((e) => e.id));
  return sortEntries([...fromSnapshot, ...confirmed.filter((e) => !ids.has(e.id))]);
}

function uniqueNonEmpty(values: Iterable<string>, limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const v = raw.trim();
    const key = v.toLowerCase();
    if (!v || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= limit) break;
  }
  return out;
}

/** Sugerencias de emisor: "Central", unidades vistas por el análisis y emisores recientes de la bitácora. */
export function speakerSuggestions(analysis: CommsAnalysis | null, entries: readonly CommEntry[], limit = 24): string[] {
  const recent = [...entries].reverse().map((e) => e.speaker);
  return uniqueNonEmpty(["Central", ...(analysis?.units.map((u) => u.name) ?? []), ...recent], limit);
}

/** Canales usados en la bitácora, del más reciente al más antiguo. */
export function channelSuggestions(entries: readonly CommEntry[], limit = 8): string[] {
  return uniqueNonEmpty(
    [...entries].reverse().map((e) => e.channel),
    limit,
  );
}

/** URL estable (/api/files) de la grabación de una entrada. */
export function commAudioUrl(audioPath: string): string {
  return `/api/files/${audioPath.split("/").map(encodeURIComponent).join("/")}`;
}

/** Entrada que el panel envía (forma ya normalizada de AddCommInput). */
export interface DraftComm {
  text: string;
  speaker: string;
  channel: string;
  /** Desde la página solo se escribe o importa; "zello" lo crea el servidor y "dictation" queda en entradas antiguas. */
  source: "manual" | "import";
  /** ISO; si falta, el servidor usa la hora de ingreso. */
  at?: string;
  /** Grabación de la transmisión: se sube primero y la entrada queda con su audio_path. */
  audio?: Blob | null;
}

/** Entrada mostrada de inmediato mientras el servidor la confirma (o si falló). */
export interface PendingComm {
  localId: string;
  incidentId: string;
  input: DraftComm;
  /** Hora local en que se creó, para ubicarla en la bitácora. */
  createdAt: string;
  status: "sending" | "failed";
  error: string | null;
}
