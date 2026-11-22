/**
 * Lógica pura del briefing en ruta: qué cambió entre dos snapshots (para el aviso
 * "ACTUALIZACIÓN" y la relectura en voz alta), textos de cantidad y enlaces de navegación.
 *
 * Regla de oro: ausencia de evidencia ≠ ausencia de víctimas. Nada aquí produce un texto
 * que se lea como "no hay personas atrapadas" salvo `cleared_by_unit` (informado por radio).
 */
import type { BriefingSnapshot } from "@/lib/contract";
import type { HazardKind, HazardSeverity, IncidentStatus, SituationReport, TrappedStatus } from "@/lib/domain";
import {
  hazardKindLabel,
  hazardSeverityLabel,
  labelOr,
  severityLabel,
  severityRank,
  trappedStatusLabel,
  trappedStatusShort,
} from "@/lib/labels";
import { pluralize } from "@/lib/format";

/* ─────────────────────────── Tipos ─────────────────────────── */

export type BriefingChangeKind =
  | "situation"
  | "trapped"
  | "trapped_count"
  | "severity"
  | "hazards"
  | "status"
  | "headline"
  | "verified";

export interface BriefingChange {
  kind: BriefingChangeKind;
  /** Frase en español, lista para el aviso. */
  text: string;
  /** true si amerita el aviso "ACTUALIZACIÓN" y vibrar. */
  important: boolean;
}

export interface BriefingDiff {
  important: boolean;
  changes: BriefingChange[];
}

/* ─────────────────────────── Cantidad de atrapados ─────────────────────────── */

function safeCount(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** Rango saneado: tolera NaN, negativos y máximo menor que el mínimo (manda el mínimo). */
export function trappedRange(trapped: SituationReport["trapped"]): { min: number; max: number } {
  const min = safeCount(trapped.count_min);
  return { min, max: Math.max(min, safeCount(trapped.count_max)) };
}

/**
 * Cantidad de atrapados para pantalla y voz, o null si no corresponde mostrarla.
 * Nunca muestra "0 personas": se leería como "no hay nadie".
 */
export function trappedCountText(trapped: SituationReport["trapped"]): string | null {
  const { min, max } = trappedRange(trapped);
  const raised = trapped.status === "confirmed" || trapped.status === "probable" || trapped.status === "possible";
  if (max === 0) return raised ? "Cantidad sin determinar" : null;
  if (min === max) return pluralize(min, "persona");
  if (min === 0) return `Hasta ${pluralize(max, "persona")}`;
  return `${min} a ${max} personas`;
}

/* ─────────────────────────── Diff ─────────────────────────── */

const NO_CHANGES: BriefingDiff = { important: false, changes: [] };

const STATUS_TEXT: Record<IncidentStatus, string> = {
  active: "La emergencia volvió a estar activa.",
  controlled: "La emergencia fue declarada CONTROLADA.",
  closed: "La emergencia fue CERRADA por el puesto de mando.",
};

const HAZARD_SEVERITY_RANK: Record<HazardSeverity, number> = { low: 0, medium: 1, high: 2 };

/** Minúsculas, sin tildes ni signos y con espacios simples: para comparar descripciones. */
export function normalizeText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ]+/g, " ")
    .trim();
}

function trappedLabel(s: TrappedStatus): string {
  return labelOr(trappedStatusLabel, s, "SIN DATO");
}

function hazardText(prefix: string, kind: HazardKind, description: string): string {
  const label = labelOr(hazardKindLabel, kind, "Peligro");
  const desc = description.trim();
  return desc ? `${prefix}: ${label} — ${desc}` : `${prefix}: ${label}`;
}

type Hazard = SituationReport["hazards"][number];

function groupByKind(list: Hazard[]): Map<HazardKind, Hazard[]> {
  const map = new Map<HazardKind, Hazard[]>();
  for (const h of list) {
    const arr = map.get(h.kind);
    if (arr) arr.push(h);
    else map.set(h.kind, [h]);
  }
  return map;
}

function maxHazardSeverity(list: Hazard[]): number {
  return list.reduce((m, h) => Math.max(m, HAZARD_SEVERITY_RANK[h.severity] ?? 0), -1);
}

/**
 * Peligros nuevos o agravados. Un tipo que no existía es nuevo; dentro de un tipo ya conocido,
 * solo cuentan como nuevos los que superan la cantidad anterior y cuya descripción no coincide
 * (la IA reescribe las descripciones en cada fusión: reformular no es un peligro nuevo).
 */
function hazardChanges(prev: Hazard[], next: Hazard[]): BriefingChange[] {
  const out: BriefingChange[] = [];
  const before = groupByKind(prev);
  for (const [kind, list] of groupByKind(next)) {
    const old = before.get(kind) ?? [];
    if (old.length === 0) {
      const seen = new Set<string>();
      for (const h of list) {
        const key = normalizeText(h.description);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ kind: "hazards", text: hazardText("Nuevo peligro", kind, h.description), important: true });
      }
      continue;
    }
    if (list.length > old.length) {
      const oldDescs = new Set(old.map((h) => normalizeText(h.description)));
      const extra = list.length - old.length;
      const fresh = list.filter((h) => !oldDescs.has(normalizeText(h.description))).slice(0, extra);
      if (fresh.length === 0) {
        out.push({ kind: "hazards", text: hazardText("Nuevo peligro", kind, ""), important: true });
      } else {
        for (const h of fresh) {
          out.push({ kind: "hazards", text: hazardText("Nuevo peligro", kind, h.description), important: true });
        }
      }
      continue;
    }
    const nextMax = maxHazardSeverity(list);
    if (nextMax > maxHazardSeverity(old)) {
      const worst = list.find((h) => (HAZARD_SEVERITY_RANK[h.severity] ?? 0) === nextMax) ?? list[0];
      const sev = labelOr(hazardSeverityLabel, worst.severity).toLowerCase();
      out.push({
        kind: "hazards",
        text: hazardText(`Peligro más grave (${sev})`, kind, worst.description),
        important: true,
      });
    }
  }
  return out;
}

function sameRange(a: SituationReport["trapped"], b: SituationReport["trapped"]): boolean {
  const ra = trappedRange(a);
  const rb = trappedRange(b);
  return ra.min === rb.min && ra.max === rb.max;
}

function situationChanges(prev: SituationReport, next: SituationReport): BriefingChange[] {
  const out: BriefingChange[] = [];

  const ps = prev.trapped.status;
  const ns = next.trapped.status;
  if (ps !== ns) {
    out.push({
      kind: "trapped",
      text: `Personas atrapadas: ahora ${trappedLabel(ns)} (antes ${labelOr(trappedStatusShort, ps, "SIN DATO")}).`,
      important: true,
    });
  } else if (!sameRange(prev.trapped, next.trapped)) {
    const now = trappedCountText(next.trapped) ?? "cantidad sin determinar";
    const before = trappedCountText(prev.trapped) ?? "sin cantidad";
    out.push({
      kind: "trapped_count",
      text: `Personas atrapadas: ahora ${now.toLowerCase()} (antes ${before.toLowerCase()}).`,
      important: true,
    });
  }

  const pr = severityRank(prev.severity);
  const nr = severityRank(next.severity);
  if (pr !== nr) {
    const verb = nr > pr ? "subió" : "bajó";
    out.push({
      kind: "severity",
      text: `Gravedad ${verb} a ${labelOr(severityLabel, next.severity)} (antes ${labelOr(severityLabel, prev.severity)}).`,
      important: true,
    });
  }

  out.push(...hazardChanges(prev.hazards, next.hazards));

  if (normalizeText(prev.headline) !== normalizeText(next.headline) && next.headline.trim()) {
    out.push({ kind: "headline", text: `Nuevo resumen: ${next.headline.trim()}`, important: false });
  }
  return out;
}

/**
 * Qué cambió entre el snapshot anterior y el nuevo. El primero (prev null o de otro incidente)
 * no produce cambios: no hay nada que avisar todavía.
 */
export function diffBriefing(prev: BriefingSnapshot | null, next: BriefingSnapshot): BriefingDiff {
  if (!prev || prev.incident.id !== next.incident.id) return NO_CHANGES;

  const changes: BriefingChange[] = [];

  if (prev.incident.status !== next.incident.status) {
    changes.push({ kind: "status", text: STATUS_TEXT[next.incident.status], important: true });
  }

  const a = prev.situation;
  const b = next.situation;
  if (!a && b) {
    const count = trappedCountText(b.trapped);
    const trapped = `Personas atrapadas: ${trappedLabel(b.trapped.status)}${count ? ` (${count.toLowerCase()})` : ""}.`;
    changes.push({ kind: "situation", text: `Llegó el primer análisis. ${trapped}`, important: true });
    for (const h of b.hazards) {
      if (h.severity === "high") {
        changes.push({ kind: "hazards", text: hazardText("Peligro", h.kind, h.description), important: true });
      }
    }
  } else if (a && !b) {
    changes.push({
      kind: "situation",
      text: "El análisis dejó de estar disponible. Pide la información por radio.",
      important: true,
    });
  } else if (a && b) {
    changes.push(...situationChanges(a, b));
  }

  if (prev.incident.verified !== next.incident.verified) {
    changes.push({
      kind: "verified",
      text: next.incident.verified
        ? "El puesto de mando verificó la emergencia."
        : "La emergencia quedó SIN VERIFICAR.",
      important: false,
    });
  }

  if (changes.length === 0) return NO_CHANGES;
  return { important: changes.some((c) => c.important), changes };
}

/**
 * Suma cambios nuevos a los que el aviso ya muestra (sin repetir frases), conservando los
 * `max` más recientes.
 */
export function mergeChanges(pending: BriefingChange[], incoming: BriefingChange[], max = 8): BriefingChange[] {
  const out = pending.filter((p) => !incoming.some((c) => c.text === p.text));
  out.push(...incoming);
  return out.slice(-max);
}

/* ─────────────────────────── Voz ─────────────────────────── */

/** Texto del briefing para leer en voz alta; vacío si aún no hay análisis. */
export function spokenText(snapshot: BriefingSnapshot | null): string {
  return snapshot?.situation?.briefing.spoken.trim() ?? "";
}

/**
 * Lo que se lee en voz alta cuando aparece un aviso "ACTUALIZACIÓN": los mismos cambios
 * importantes del aviso, no el briefing entero. La IA reescribe el texto hablado en cada
 * fusión (cada video o radio nueva): releerlo completo tapaba qué cambió y repetía ~45 s de
 * audio sin novedad. El primer análisis sí se lee completo: es la noticia más importante.
 */
export function autoReadText(changes: readonly BriefingChange[], next: BriefingSnapshot | null): string | null {
  const important = changes.filter((c) => c.important);
  if (important.length === 0) return null;
  const parts = important.map((c) => c.text.trim()).filter(Boolean);
  if (important.some((c) => c.kind === "situation")) {
    const full = spokenText(next);
    if (full) parts.push(full);
  }
  return parts.length > 0 ? `Actualización. ${parts.join(" ")}` : null;
}

/* ─────────────────────────── Varios ─────────────────────────── */

function coord(n: number): string {
  return Number.isFinite(n) ? String(Math.round(n * 1e6) / 1e6) : "0";
}

/** Indicaciones de Google Maps hasta el lugar. */
export function googleMapsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${coord(lat)},${coord(lng)}`;
}

/** Navegación en Waze hasta el lugar. */
export function wazeUrl(lat: number, lng: number): string {
  return `https://waze.com/ul?ll=${coord(lat)},${coord(lng)}&navigate=yes`;
}

/** "Actualizado hace 8 s" / "hace 3 min"; null si aún no hay respuesta o reloj. */
export function updatedAgoText(lastUpdatedAt: number | null, now: number | null): string | null {
  if (lastUpdatedAt === null || now === null) return null;
  const s = Math.max(0, Math.floor((now - lastUpdatedAt) / 1000));
  if (s < 60) return `Actualizado hace ${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `Actualizado hace ${m} min`;
  return `Actualizado hace ${Math.floor(m / 60)} h`;
}

/** Peligros ordenados de más a menos grave (estable). */
export function sortHazards<T extends { severity: HazardSeverity }>(list: T[]): T[] {
  return list
    .map((h, i) => ({ h, i }))
    .sort((x, y) => (HAZARD_SEVERITY_RANK[y.h.severity] ?? 0) - (HAZARD_SEVERITY_RANK[x.h.severity] ?? 0) || x.i - y.i)
    .map((x) => x.h);
}
