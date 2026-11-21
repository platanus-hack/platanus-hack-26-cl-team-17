"use client";
/** Panel de detalle de la entidad seleccionada (datos, nota, confianza y evidencia). */
import type { ReactNode } from "react";
import { ExternalLink, ImageOff, X } from "lucide-react";
import type { Confidence, EvidenceRef } from "@/lib/domain";
import { formatBearing } from "@/lib/geo";
import type { EntityRef } from "./model";
import {
  ACCESS_KIND_LABEL,
  CONFIDENCE_LABEL,
  CONSTRUCTION_LABEL,
  HAZARD_KIND_LABEL,
  HAZARD_SEVERITY_LABEL,
  INTENSITY_LABEL,
  MEDIA_SOURCE_LABEL,
  MISSION_MODE_LABEL,
  MISSION_STATUS_LABEL,
  PERSON_STATUS_LABEL,
  ROLE_LABEL,
  ROOF_LABEL,
  SIDE_LABEL,
  SMOKE_COLOR_LABEL,
  SMOKE_VOLUME_LABEL,
  STRUCTURE_KIND_LABEL,
  VEHICLE_KIND_LABEL,
  VEHICLE_STATE_LABEL,
  floorOrdinal,
  formatMeters,
  frameLabel,
  personCaption,
  pluralFloors,
  structureTitle,
} from "./labels";
import { CONFIDENCE_TONE, HAZARD_TONE, type Tone } from "./icons";
import { TONE_BADGE, cx } from "./tones";

export interface InspectorProps {
  entity: EntityRef;
  /** Título de la estructura asociada (personas y focos). */
  structureName?: (id: string | null) => string | null;
  onClose: () => void;
  onOpenMedia?: (mediaLabel: string, frame?: number) => void;
  className?: string;
}

function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={cx("inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-semibold", TONE_BADGE[tone])}>
      {children}
    </span>
  );
}

function ConfidenceBadge({ value }: { value: Confidence }) {
  return <Badge tone={CONFIDENCE_TONE[value]}>Confianza {CONFIDENCE_LABEL[value]}</Badge>;
}

type Row = [string, ReactNode] | null | false;

function Rows({ rows }: { rows: Row[] }) {
  const items = rows.filter((r): r is [string, ReactNode] => Array.isArray(r));
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 break-words text-text">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Note({ text }: { text: string }) {
  if (!text) return null;
  return <p className="rounded border border-line bg-surface-2 px-2 py-1.5 text-[13px] leading-snug text-text">{text}</p>;
}

function EvidenceChips({ evidence, onOpenMedia }: { evidence: EvidenceRef[]; onOpenMedia?: InspectorProps["onOpenMedia"] }) {
  if (evidence.length === 0) {
    return <p className="text-[12px] text-muted">Sin evidencia citada por la IA.</p>;
  }
  return (
    <ul className="flex flex-wrap gap-1.5">
      {evidence.map((ev, i) => {
        const frame = frameLabel(ev.frame);
        const text = frame ? `${ev.ref} · ${frame}` : ev.ref;
        const isMedia = /^M\d+$/i.test(ev.ref);
        return (
          <li key={`${ev.ref}-${ev.frame}-${i}`}>
            {isMedia && onOpenMedia ? (
              <button
                type="button"
                onClick={() => onOpenMedia(ev.ref.toUpperCase(), ev.frame >= 0 ? ev.frame : undefined)}
                title={ev.note || `Abrir ${ev.ref}`}
                className="inline-flex items-center gap-1 rounded border border-info/50 bg-info-soft px-1.5 py-0.5 font-mono text-[11px] font-semibold text-info hover:bg-info/25"
              >
                {text}
                <ExternalLink className="size-3" aria-hidden="true" />
              </button>
            ) : (
              <span
                title={ev.note || undefined}
                className="inline-flex items-center rounded border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-muted"
              >
                {text}
              </span>
            )}
            {ev.note && <span className="sr-only">: {ev.note}</span>}
          </li>
        );
      })}
    </ul>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h4 className="label-caps text-[11px] text-muted">{title}</h4>
      {children}
    </section>
  );
}

interface Body {
  kicker: string;
  title: string;
  tone: Tone;
  content: ReactNode;
  /** Nota de procedencia al pie (por defecto: inferido por IA). */
  foot?: string | null;
}

const AI_FOOT = "Dato inferido por IA: confirma en el lugar.";

function body(entity: EntityRef, props: InspectorProps): Body {
  const structureName = props.structureName ?? (() => null);
  switch (entity.kind) {
    case "structure": {
      const s = entity.item;
      const assumed = [
        s.assumed.floors && "cantidad de pisos",
        s.assumed.size && "dimensiones",
        s.assumed.floorHeight && "altura de piso",
      ].filter(Boolean);
      return {
        kicker: `Estructura · ${ROLE_LABEL[s.role]}`,
        title: structureTitle(s),
        tone: s.role === "involved" ? "accent" : s.role === "exposure" ? "warning" : "muted",
        content: (
          <>
            <div className="flex flex-wrap gap-1.5">
              <ConfidenceBadge value={s.confidence} />
            </div>
            <Rows
              rows={[
                ["Tipo", STRUCTURE_KIND_LABEL[s.kind]],
                ["Pisos", pluralFloors(s.floors)],
                ["Material", CONSTRUCTION_LABEL[s.construction]],
                ["Planta", `${formatMeters(s.width)} × ${formatMeters(s.depth).replace("≈ ", "")}`],
                ["Altura", formatMeters(s.height + s.roofHeight)],
                ["Techo", ROOF_LABEL[s.roof]],
                ["Fachada hacia", formatBearing(s.rotationDeg)],
              ]}
            />
            {assumed.length > 0 && (
              <p className="text-[12px] text-warning">Supuesto del visor (no informado por la IA): {assumed.join(", ")}.</p>
            )}
            <Note text={s.notes} />
          </>
        ),
      };
    }
    case "fire": {
      const f = entity.item;
      return {
        kicker: "Foco",
        title: f.intensity === "smoke_only" ? "Humo sin llama visible" : INTENSITY_LABEL[f.intensity],
        tone: f.intensity === "heavy" ? "critical" : "accent",
        content: (
          <>
            <div className="flex flex-wrap gap-1.5">
              <ConfidenceBadge value={f.confidence} />
            </div>
            <Rows
              rows={[
                f.structureId !== null && ["Estructura", structureName(f.structureId) ?? f.structureId],
                ["Piso", f.floor >= 1 ? floorOrdinal(f.floor) : "Exterior o no determinado"],
                ["Costado", SIDE_LABEL[f.side]],
                ["Radio", formatMeters(f.radius)],
                ["Altura", formatMeters(f.z)],
              ]}
            />
            <Note text={f.note} />
          </>
        ),
      };
    }
    case "smoke": {
      const s = entity.item;
      return {
        kicker: "Humo",
        title: `Columna de humo ${SMOKE_COLOR_LABEL[s.color]}`,
        tone: "muted",
        content: (
          <Rows
            rows={[
              ["Volumen", SMOKE_VOLUME_LABEL[s.volume]],
              ["Color", SMOKE_COLOR_LABEL[s.color]],
              ["Deriva hacia", s.driftDeg === null ? "No determinada" : formatBearing(s.driftDeg)],
            ]}
          />
        ),
      };
    }
    case "person": {
      const p = entity.item;
      const critical = p.risk === "critical";
      return {
        kicker: critical ? "Persona en riesgo" : "Personas",
        title: personCaption(p),
        tone: critical ? "critical" : p.risk === "injured" ? "warning" : "muted",
        content: (
          <>
            <div className="flex flex-wrap gap-1.5">
              <Badge tone={critical ? "critical" : p.risk === "injured" ? "warning" : "muted"}>{PERSON_STATUS_LABEL[p.status]}</Badge>
              <ConfidenceBadge value={p.confidence} />
            </div>
            <Rows
              rows={[
                ["Cantidad", p.count >= 1 ? String(p.count) : "No determinada"],
                ["Piso", p.floor >= 1 ? floorOrdinal(p.floor) : "Exterior o no determinado"],
                p.structureId !== null && ["Estructura", structureName(p.structureId) ?? p.structureId],
              ]}
            />
            <Note text={p.note} />
            <Section title="Evidencia">
              <EvidenceChips evidence={p.evidence} onOpenMedia={props.onOpenMedia} />
            </Section>
            {critical && (
              <p className="text-[12px] text-muted">
                La ausencia de otras personas en el material no descarta víctimas.
              </p>
            )}
          </>
        ),
      };
    }
    case "vehicle": {
      const v = entity.item;
      return {
        kicker: "Vehículo",
        title: VEHICLE_KIND_LABEL[v.kind],
        tone: v.entrapment ? "critical" : v.burning ? "accent" : "muted",
        content: (
          <>
            <div className="flex flex-wrap gap-1.5">
              {v.entrapment && <Badge tone="critical">Posible atrapamiento</Badge>}
              {v.burning && <Badge tone="accent">En llamas</Badge>}
            </div>
            <Rows
              rows={[
                ["Posición", VEHICLE_STATE_LABEL[v.state]],
                ["Tamaño", `${formatMeters(v.length)} × ${formatMeters(v.width).replace("≈ ", "")}`],
                ["Frente hacia", formatBearing(v.rotationDeg)],
              ]}
            />
            <Note text={v.note} />
          </>
        ),
      };
    }
    case "hazard": {
      const h = entity.item;
      return {
        kicker: "Peligro",
        title: HAZARD_KIND_LABEL[h.kind],
        tone: HAZARD_TONE[h.severity],
        content: (
          <>
            <div className="flex flex-wrap gap-1.5">
              <Badge tone={HAZARD_TONE[h.severity]}>Severidad {HAZARD_SEVERITY_LABEL[h.severity]}</Badge>
            </div>
            <Rows
              rows={[
                ["Zona sugerida", `radio ${formatMeters(h.radius)}`],
                h.z > 0.5 && ["Altura", formatMeters(h.z)],
              ]}
            />
            <Note text={h.note} />
          </>
        ),
      };
    }
    case "access": {
      const a = entity.item;
      return {
        kicker: "Acceso",
        title: a.label || ACCESS_KIND_LABEL[a.kind],
        tone: a.kind === "hydrant" ? "info" : "ok",
        content: (
          <>
            <Rows rows={[["Tipo", ACCESS_KIND_LABEL[a.kind]]]} />
            <Note text={a.note} />
          </>
        ),
      };
    }
    case "road": {
      const r = entity.item;
      return {
        kicker: "Calle",
        title: r.name || "Vía sin nombre",
        tone: r.blocked ? "warning" : "muted",
        content: (
          <>
            {r.blocked && (
              <div>
                <Badge tone="warning">Bloqueada para carros</Badge>
              </div>
            )}
            <Rows
              rows={[
                ["Ancho", formatMeters(r.width)],
                ["Tramo dibujado", formatMeters(r.length)],
              ]}
            />
          </>
        ),
      };
    }
    case "camera": {
      const c = entity.item;
      return {
        kicker: "Cámara del medio",
        title: c.mediaRef,
        tone: "info",
        foot: c.origin === "gps" ? "Posición informada por el dispositivo (precisión variable)." : AI_FOOT,
        content: (
          <>
            {c.posterUrl ? (
              // Las URLs de /api/files redirigen a una URL firmada: no pasan por el optimizador de imágenes.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={c.posterUrl}
                alt={`Vista previa de ${c.mediaRef}`}
                loading="lazy"
                className="aspect-video w-full rounded border border-line bg-surface-2 object-cover"
              />
            ) : (
              <div className="grid aspect-video w-full place-items-center rounded border border-line bg-surface-2 text-muted">
                <ImageOff className="size-5" aria-hidden="true" />
              </div>
            )}
            <div className="flex flex-wrap gap-1.5">
              <ConfidenceBadge value={c.confidence} />
            </div>
            <Rows
              rows={[
                c.source !== null && ["Fuente", MEDIA_SOURCE_LABEL[c.source]],
                ["Posición", c.origin === "gps" ? "GPS del dispositivo" : "Estimada por la IA"],
                ["Mira hacia", c.facingDeg === null ? "No determinado" : formatBearing(c.facingDeg)],
                c.z > 3 && ["Altura", formatMeters(c.z)],
              ]}
            />
            {props.onOpenMedia && (
              <button
                type="button"
                onClick={() => props.onOpenMedia?.(c.mediaRef)}
                className="inline-flex items-center justify-center gap-1.5 rounded border border-info/50 bg-info-soft px-3 py-1.5 text-[13px] font-semibold text-info hover:bg-info/25"
              >
                <ExternalLink className="size-4" aria-hidden="true" />
                Abrir {c.mediaRef}
              </button>
            )}
          </>
        ),
      };
    }
    case "drone": {
      const d = entity.item;
      return {
        kicker: "Dron",
        title: d.label,
        tone: "drone",
        foot: d.mode === "simulated" ? "Telemetría simulada: no es un dron real." : "Telemetría informada por el dron.",
        content: (
          <>
            <div className="flex flex-wrap gap-1.5">
              <Badge tone={d.active ? "drone" : "muted"}>{MISSION_STATUS_LABEL[d.status]}</Badge>
              {d.mode === "simulated" && <Badge tone="warning">Dron simulado</Badge>}
            </div>
            <Rows
              rows={[
                ["Modo", MISSION_MODE_LABEL[d.mode]],
                ["Altura", formatMeters(d.z)],
                ["Rumbo", formatBearing(d.headingDeg)],
                d.speedMs !== null && ["Velocidad", `${Math.round(d.speedMs * 10) / 10} m/s`.replace(".", ",")],
                d.batteryPct !== null && ["Batería", `${Math.round(d.batteryPct)} %`],
                ["Puntos de traza", String(d.track.length)],
              ]}
            />
          </>
        ),
      };
    }
  }
}

/** Inspector: se muestra junto al visor cuando hay una entidad seleccionada (no en modo compacto). */
export function Inspector(props: InspectorProps) {
  const { kicker, title, tone, content, foot = AI_FOOT } = body(props.entity, props);
  return (
    <aside
      className={cx("flex flex-col gap-2.5 overflow-auto rounded-[var(--radius-panel)] border border-line-strong bg-surface p-3 text-text", props.className)}
      aria-label={`Detalle: ${title}`}
    >
      <header className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className={cx("label-caps text-[11px]", tone === "critical" ? "text-critical" : "text-muted")}>{kicker}</p>
          <h3 className="font-display text-lg leading-tight font-semibold break-words">{title}</h3>
        </div>
        <button
          type="button"
          onClick={props.onClose}
          className="grid size-7 shrink-0 place-items-center rounded text-muted hover:bg-surface-2 hover:text-text"
          aria-label="Cerrar detalle"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </header>
      {content}
      {foot && <p className="text-[11px] text-faint">{foot}</p>}
    </aside>
  );
}
