/**
 * Qué lados de la emergencia cubren los videos. Puro.
 *
 * Con la escena reconstruida (estructura principal con el rumbo de su fachada) se usan
 * los lados de bomberos: A = frente, B, C = atrás, D, en sentido horario visto desde
 * arriba. Sin escena, por el rumbo desde el incidente hasta la cámara: norte, este, sur
 * u oeste. Un video sin ubicación cuenta como video, pero no cubre ningún lado.
 */
import type { Incident, Media } from "@/lib/domain";
import { bearingDeg, normalizeDeg, toLocal } from "@/lib/geo";
import type { VigiaSideCoverage } from "./types";

export type SideScheme = "abcd" | "cardinal";

const ABCD = ["A", "B", "C", "D"] as const;
const CARDINAL = ["norte", "este", "sur", "oeste"] as const;

export interface CoverageResult {
  scheme: SideScheme;
  coverage: VigiaSideCoverage[];
  /** Lados sin ningún video. */
  blind: string[];
  /** Lado que ve cada medio (por etiqueta); null si el medio no tiene ubicación. */
  sideOf: Record<string, string | null>;
}

type MediaLike = Pick<Media, "label" | "lat" | "lng" | "status" | "analysis" | "source">;
type IncidentLike = Pick<Incident, "lat" | "lng" | "scene">;

/** Medios que aportan a la cobertura: no fallidos y, si ya se analizaron, utilizables. */
export function coveringMedia<T extends MediaLike>(media: T[]): T[] {
  return media.filter((m) => m.status !== "failed" && m.analysis?.usable !== false);
}

function nearestIndex(bearing: number, base: number): number {
  return Math.round(normalizeDeg(bearing - base) / 90) % 4;
}

/** Lado de bomberos que ve una cámara en (x, y) respecto de una estructura. */
export function abcdSide(camera: { x: number; y: number }, structure: { x: number; y: number; rotation_deg: number }): string {
  const dx = camera.x - structure.x;
  const dy = camera.y - structure.y;
  const bearing = normalizeDeg((Math.atan2(dx, dy) * 180) / Math.PI);
  return ABCD[nearestIndex(bearing, structure.rotation_deg)];
}

export function computeCoverage(incident: IncidentLike, media: MediaLike[]): CoverageResult {
  const usable = coveringMedia(media);
  const structure = incident.scene?.structures.find((s) => s.role === "involved") ?? null;
  const scheme: SideScheme = structure ? "abcd" : "cardinal";
  const names: readonly string[] = scheme === "abcd" ? ABCD : CARDINAL;
  const bySide = new Map<string, string[]>(names.map((n) => [n, []]));
  const sideOf: Record<string, string | null> = {};
  const origin = { lat: incident.lat, lng: incident.lng };
  const sceneCameras = new Map((incident.scene?.cameras ?? []).map((c) => [c.media_ref, c]));

  for (const m of usable) {
    let side: string | null = null;
    if (structure) {
      const cam = sceneCameras.get(m.label);
      const pos = cam
        ? { x: cam.x, y: cam.y }
        : m.lat !== null && m.lng !== null
          ? toLocal(origin, { lat: m.lat, lng: m.lng })
          : null;
      if (pos && (Math.abs(pos.x - structure.x) > 0.5 || Math.abs(pos.y - structure.y) > 0.5)) {
        side = abcdSide(pos, structure);
      }
    } else if (m.lat !== null && m.lng !== null) {
      const local = toLocal(origin, { lat: m.lat, lng: m.lng });
      // A menos de 3 m del punto del incidente no se puede saber de qué lado está.
      if (Math.hypot(local.x, local.y) > 3) {
        side = CARDINAL[nearestIndex(bearingDeg(origin, { lat: m.lat, lng: m.lng }), 0)];
      }
    }
    sideOf[m.label] = side;
    if (side) bySide.get(side)?.push(m.label);
  }

  const coverage = names.map((side) => ({ side, media: bySide.get(side) ?? [] }));
  // Sin ningún video ubicado no se puede decir qué lado falta: no se reporta "sin ver" nada.
  const anyLocated = coverage.some((c) => c.media.length > 0);
  const blind = anyLocated ? coverage.filter((c) => c.media.length === 0).map((c) => c.side) : [];
  return { scheme, coverage, blind, sideOf };
}

/** "el lado C" / "el lado norte". */
export function sideName(side: string): string {
  return `el lado ${side}`;
}

/** "el lado C" · "los lados B y C" · "los lados B, C y D". */
export function sidesText(sides: string[]): string {
  if (sides.length === 0) return "";
  if (sides.length === 1) return sideName(sides[0]);
  return `los lados ${sides.slice(0, -1).join(", ")} y ${sides.at(-1)}`;
}

/** Lado mencionado en una pregunta: "¿se ve alguien en el lado B?" → "B"; "atrás" → "C". */
export function sideInText(text: string, scheme: SideScheme): string | null {
  const t = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  if (scheme === "abcd") {
    const m = /\blado\s+([abcd])\b|\bcostado\s+([abcd])\b|\bsector\s+([abcd])\b/.exec(t);
    if (m) return (m[1] ?? m[2] ?? m[3]).toUpperCase();
    if (/\b(frente|fachada|delante)\b/.test(t)) return "A";
    if (/\b(atras|trasero|trasera|posterior|fondo)\b/.test(t)) return "C";
    return null;
  }
  const m = /\b(norte|sur|este|oeste|oriente|poniente)\b/.exec(t);
  if (!m) return null;
  return m[1] === "oriente" ? "este" : m[1] === "poniente" ? "oeste" : m[1];
}
