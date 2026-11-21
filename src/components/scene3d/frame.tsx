"use client";
/**
 * Marco común del visor (3D y planta 2D): barra con insignias de honestidad
 * (simulada, confianza, antigüedad, actualizando), vistas rápidas, capas,
 * simbología, supuestos, cambio 2D/3D, leyenda fija e inspector.
 */
import { useState, type KeyboardEvent, type ReactNode } from "react";
import {
  Box,
  ChevronDown,
  Clock,
  Eye,
  FlaskConical,
  Info,
  Layers,
  ListChecks,
  LoaderCircle,
  Map as MapIcon,
  Rotate3d,
  Shapes,
  X,
} from "lucide-react";
import type { AnalysisEngine } from "@/lib/domain";
import { VIEW_PRESETS, type ViewPreset } from "./geometry";
import { findEntity, type SceneView } from "./model";
import { LAYERS, type LayerKey, type LayerState } from "./layers";
import type { SceneSelection } from "./types";
import { CONFIDENCE_LABEL, EMPTY_TEXT, LEGEND_TEXT, SURROUNDINGS_TEXT, formatAgo, structureTitle, viewerAssumptions } from "./labels";
import { CONFIDENCE_TONE } from "./icons";
import { TONE_BADGE, cx } from "./tones";
import { Inspector } from "./inspector";
import { useNow } from "./hooks";
import type { SurroundingsStatus } from "./surroundings-data";

type PanelKey = "layers" | "legend" | "assumptions";

export interface SceneFrameProps {
  view: SceneView | null;
  engine: AnalysisEngine | null;
  updatedAt: string | null;
  updating: boolean;
  compact: boolean;
  className?: string;
  mode: "3d" | "2d";
  /** Cambiar entre 3D y planta (sin función = sin botón). */
  onToggleMode?: () => void;
  /** Si existe, el botón de 3D queda deshabilitado con este motivo. */
  toggleDisabledReason?: string | null;
  layers: LayerState;
  onLayersChange: (next: LayerState) => void;
  /** Estado de la descarga del entorno OSM (aviso pequeño en el panel de capas). */
  surroundingsStatus?: SurroundingsStatus;
  surroundingsCount?: number;
  selection: SceneSelection | null;
  onSelect: (sel: SceneSelection | null) => void;
  onOpenMedia?: (mediaLabel: string, frame?: number) => void;
  /** Vistas rápidas (solo 3D). */
  onViewPreset?: (preset: ViewPreset) => void;
  /** Aviso en una franja bajo la barra (p. ej. caída a 2D). */
  notice?: ReactNode;
  children: ReactNode;
}

/**
 * Botón de la barra. Con `showLabel="wide"` el texto aparece solo si la barra es ancha
 * (consulta de contenedor sobre la propia barra, no sobre la escena a pantalla completa).
 */
function ToolButton({
  onClick,
  active,
  disabled,
  title,
  icon,
  label,
  showLabel = "always",
  pressed,
  count,
  trailing,
  expanded,
}: {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  icon: ReactNode;
  label: string;
  showLabel?: "always" | "medium" | "wide";
  pressed?: boolean;
  /** Número chico junto al ícono (p. ej. cantidad de supuestos). */
  count?: number;
  trailing?: ReactNode;
  expanded?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      aria-pressed={pressed}
      aria-expanded={expanded}
      className={cx(
        "inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-[12px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45",
        active ? "bg-info-soft text-info" : "text-muted hover:bg-surface-2 hover:text-text",
      )}
    >
      {icon}
      <span className={LABEL_CLASS[showLabel]}>{label}</span>
      {count ? (
        <span aria-hidden="true" className="tabular min-w-4 rounded-full bg-surface-2 px-1 text-[11px] leading-4 text-muted">
          {count}
        </span>
      ) : null}
      {trailing}
    </button>
  );
}

const LABEL_CLASS = { always: undefined, medium: "sr-only @md/bar:not-sr-only", wide: "sr-only @3xl/bar:not-sr-only" } as const;

/** Vistas rápidas en un menú (Isométrica, Planta, Frente, Posterior): ocupa un solo botón en la barra. */
function ViewMenu({ onPick }: { onPick: (preset: ViewPreset) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="relative"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          setOpen(false);
          e.stopPropagation();
        }
      }}
    >
      <ToolButton
        onClick={() => setOpen((v) => !v)}
        active={open}
        expanded={open}
        icon={<Eye className="size-4" aria-hidden="true" />}
        label="Vista"
        showLabel="wide"
        trailing={<ChevronDown className="size-3.5" aria-hidden="true" />}
      />
      {open && (
        <div
          role="menu"
          aria-label="Vistas rápidas"
          className="absolute top-full right-0 z-50 mt-1 flex w-36 flex-col rounded-xl border border-line bg-surface p-1 shadow-[0_8px_24px_rgb(0_0_0/0.14)]"
        >
          {VIEW_PRESETS.map((v) => (
            <button
              key={v.key}
              type="button"
              role="menuitem"
              onClick={() => {
                onPick(v.key);
                setOpen(false);
              }}
              className="rounded-lg px-2 py-1.5 text-left text-[13px] font-medium text-text hover:bg-surface-2"
            >
              {v.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PanelShell({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div
      role="dialog"
      aria-label={title}
      className="absolute top-[calc(var(--scene-hud-t,0px)+0.5rem)] right-[calc(var(--scene-hud-r,0px)+0.5rem)] z-50 flex max-h-[calc(100%-1rem-var(--scene-hud-t,0px)-var(--scene-hud-b,0px))] w-[min(20rem,calc(100%-1rem))] flex-col overflow-hidden rounded-[var(--radius-panel)] border border-line-strong bg-surface text-text"
    >
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
        <h3 className="label-caps flex-1 text-[12px] text-muted">{title}</h3>
        <button
          type="button"
          onClick={onClose}
          className="grid size-6 place-items-center rounded text-muted hover:bg-surface-2 hover:text-text"
          aria-label="Cerrar"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
      <div className="overflow-auto p-3">{children}</div>
    </div>
  );
}

const SURROUNDINGS_NOTE: Record<SurroundingsStatus, string> = {
  off: "",
  loading: "Cargando…",
  ready: "",
  error: "No disponible (sin conexión)",
};

function LayersPanel({
  layers,
  onChange,
  envStatus,
  envCount,
}: {
  layers: LayerState;
  onChange: (l: LayerState) => void;
  envStatus: SurroundingsStatus;
  envCount: number;
}) {
  const toggle = (key: LayerKey) => onChange({ ...layers, [key]: !layers[key] });
  const envNote = envStatus === "ready" ? (envCount ? `${envCount} edificios` : "Sin edificios en OSM") : SURROUNDINGS_NOTE[envStatus];
  return (
    <div className="flex flex-col gap-1">
      {LAYERS.map((l) => (
        <label key={l.key} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-[13px] hover:bg-surface-2">
          <input type="checkbox" checked={layers[l.key]} onChange={() => toggle(l.key)} className="size-4 accent-[var(--color-info)]" />
          {l.label}
          {l.key === "surroundings" && envNote && <span className="ml-auto text-[11px] text-faint">{envNote}</span>}
        </label>
      ))}
      <p className="mt-1 text-[11px] text-muted">Las personas en riesgo se rotulan siempre que la capa Personas esté activa.</p>
      <p className="text-[11px] text-muted">Entorno real: edificios y calles de © OpenStreetMap según el GPS del incidente; solo referencia, no lo infiere la IA.</p>
    </div>
  );
}

function Swatch({ children }: { children: ReactNode }) {
  return (
    <svg width="26" height="18" viewBox="0 0 26 18" aria-hidden="true" className="shrink-0">
      {children}
    </svg>
  );
}

/** Simbología: la misma en 3D y en la planta. */
function LegendPanel() {
  const items: [ReactNode, string][] = [
    [<rect key="a" x="3" y="3" width="20" height="12" className="fill-fire/15 stroke-fire" strokeWidth="1.5" />, "Estructura afectada"],
    [<rect key="a" x="3" y="3" width="20" height="12" className="fill-warning/10 stroke-warning/70" strokeWidth="1.5" />, "Exposición (en riesgo de propagación)"],
    [<rect key="a" x="3" y="3" width="20" height="12" className="fill-muted/10 stroke-line-strong" strokeWidth="1.5" />, "Estructura de referencia"],
    [
      <g key="a">
        <rect x="3" y="2" width="20" height="10" className="fill-none stroke-muted" strokeWidth="1" />
        <line x1="3" y1="12" x2="23" y2="12" className="stroke-text" strokeWidth="3" />
        <path d="M10 13 L13 17 L16 13 Z" className="fill-text" />
      </g>,
      "Fachada principal (lado A)",
    ],
    [<circle key="a" cx="13" cy="9" r="6" className="fill-warning stroke-fire" strokeWidth="2" />, "Foco de fuego"],
    [<circle key="a" cx="13" cy="9" r="7" className="fill-muted/30 stroke-muted" strokeDasharray="2 2" />, "Humo o bruma"],
    [<circle key="a" cx="13" cy="9" r="5" className="fill-critical stroke-bg" strokeWidth="1.5" />, "Persona en riesgo (atrapada, ventana, techo)"],
    [<circle key="a" cx="13" cy="9" r="4.5" className="fill-warning stroke-bg" strokeWidth="1.5" />, "Persona lesionada"],
    [<circle key="a" cx="13" cy="9" r="3.5" className="fill-muted" />, "Otras personas"],
    [
      <g key="a">
        <circle cx="13" cy="9" r="7.5" className="fill-critical/10 stroke-critical" strokeDasharray="3 2" />
        <rect x="8" y="6.5" width="10" height="5" className="fill-line-strong stroke-muted" />
      </g>,
      "Vehículo · posible atrapamiento",
    ],
    [<circle key="a" cx="13" cy="9" r="7.5" className="fill-warning/10 stroke-warning/70" strokeDasharray="3 2" />, "Peligro y zona sugerida"],
    [<rect key="a" x="7" y="3" width="12" height="12" rx="2" className="fill-surface stroke-info" strokeWidth="1.5" />, "Acceso, grifo o puesto"],
    [
      <g key="a">
        <path d="M5 9 L22 3 L22 15 Z" className="fill-info/15 stroke-info/60" />
        <rect x="2" y="5" width="9" height="8" rx="1.5" className="fill-info" />
      </g>,
      "Cámara del medio (M1, M2…)",
    ],
    [
      <g key="a">
        <path d="M2 14 Q10 2 20 9" className="fill-none stroke-drone" strokeDasharray="3 2" strokeWidth="1.5" />
        <path d="M20 4 L24 12 L20 10 L16 12 Z" className="fill-drone" />
      </g>,
      "Dron y su traza",
    ],
    [
      <g key="a">
        <rect x="1" y="5" width="24" height="8" className="fill-surface-2 stroke-line-strong" />
        <path d="M4 13 L10 5 M10 13 L16 5 M16 13 L22 5" className="stroke-warning" strokeWidth="2" />
      </g>,
      "Calle bloqueada",
    ],
    [
      <g key="a">
        <path d="M1 3H25M1 9H25M1 15H25M4 0V18M13 0V18M22 0V18" className="stroke-line" />
      </g>,
      "Grilla de 10 m · anillos de 25 y 50 m",
    ],
    [
      <g key="a">
        <rect x="3" y="4" width="9" height="11" className="fill-faint/15 stroke-faint/40" strokeWidth="1" />
        <rect x="14" y="7" width="9" height="8" className="fill-faint/15 stroke-faint/40" strokeWidth="1" />
      </g>,
      `${SURROUNDINGS_TEXT} (© OpenStreetMap)`,
    ],
  ];
  return (
    <ul className="flex flex-col gap-1.5 text-[12.5px]">
      {items.map(([svg, text]) => (
        <li key={text} className="flex items-center gap-2">
          <Swatch>{svg}</Swatch>
          <span>{text}</span>
        </li>
      ))}
    </ul>
  );
}

function AssumptionsPanel({ view }: { view: SceneView | null }) {
  if (!view) return <p className="text-[13px] text-muted">Aún no hay reconstrucción.</p>;
  const s = view.scene;
  const own = viewerAssumptions(s);
  return (
    <div className="flex flex-col gap-3 text-[13px] leading-snug">
      {s.description && <p className="text-text">{s.description}</p>}
      <section>
        <h4 className="label-caps mb-1 text-[11px] text-muted">Supuestos de la IA</h4>
        {s.uncertaintyNotes.length ? (
          <ul className="list-disc space-y-1 pl-4">
            {s.uncertaintyNotes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        ) : (
          <p className="text-muted">La IA no declaró supuestos geométricos.</p>
        )}
      </section>
      {s.groundNotes && (
        <section>
          <h4 className="label-caps mb-1 text-[11px] text-muted">Terreno</h4>
          <p>{s.groundNotes}</p>
        </section>
      )}
      {own.length > 0 && (
        <section>
          <h4 className="label-caps mb-1 text-[11px] text-muted">Supuestos del visor</h4>
          <ul className="list-disc space-y-1 pl-4 text-warning">
            {own.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </section>
      )}
      <section>
        <h4 className="label-caps mb-1 text-[11px] text-muted">Entorno</h4>
        <p className="text-muted">{SURROUNDINGS_TEXT}. Los edificios que coinciden con lo inferido se ocultan para no duplicarlo.</p>
      </section>
      <p className="text-[12px] text-muted">
        Posiciones, medidas y orientaciones son aproximadas y se infieren de pocas imágenes. Confírmalas en el lugar.
      </p>
    </div>
  );
}

/** Estado vacío: todavía no hay escena. */
export function SceneEmpty({ updating }: { updating: boolean }) {
  return (
    <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 px-6 py-8 text-center">
      <Box className="size-8 text-faint" aria-hidden="true" />
      <p className="max-w-sm text-[15px] font-semibold text-text">{EMPTY_TEXT}</p>
      <p className="max-w-sm text-[13px] text-muted">
        Se arma con lo que la IA infiere de los videos, fotos y el dron: estructuras, focos, personas, accesos y peligros.
      </p>
      {updating && (
        <p className="mt-1 inline-flex items-center gap-1.5 text-[13px] text-info" role="status">
          <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />
          Analizando…
        </p>
      )}
    </div>
  );
}

export function SceneFrame(props: SceneFrameProps) {
  const {
    view,
    engine,
    updatedAt,
    updating,
    compact,
    className,
    mode,
    onToggleMode,
    toggleDisabledReason,
    layers,
    onLayersChange,
    surroundingsStatus = "off",
    surroundingsCount = 0,
    selection,
    onSelect,
    onOpenMedia,
    onViewPreset,
    notice,
    children,
  } = props;
  const envShown = layers.surroundings && surroundingsStatus === "ready" && surroundingsCount > 0;
  const [panel, setPanel] = useState<PanelKey | null>(null);
  const now = useNow();
  const ago = now === null ? null : formatAgo(updatedAt, now);
  const entity = view && !compact ? findEntity(view, selection) : null;
  const togglePanel = (p: PanelKey) => setPanel((cur) => (cur === p ? null : p));

  const structureName = (id: string | null) => {
    if (!id || !view) return null;
    const s = view.scene.structures.find((st) => st.id === id);
    return s ? structureTitle(s) : null;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    if (panel) {
      setPanel(null);
      e.stopPropagation();
    } else if (selection) {
      onSelect(null);
      e.stopPropagation();
    }
  };

  const confidence = view?.scene.confidence;

  return (
    <section
      className={cx(
        "@container relative isolate flex min-h-[260px] flex-col overflow-hidden rounded-[var(--radius-panel)] border border-line bg-bg text-text",
        className,
      )}
      aria-label="Reconstrucción espacial de la escena"
      onKeyDown={onKeyDown}
    >
      {/* Barra en una sola fila: insignias de honestidad a la izquierda, herramientas como íconos a la derecha. */}
      <div className="@container/bar [position:var(--scene-chrome-pos,relative)] top-[var(--scene-safe-t,0px)] right-[var(--scene-safe-r,0px)] left-[var(--scene-safe-l,0px)] z-30 flex h-10 flex-nowrap items-center gap-1.5 rounded-[var(--scene-chrome-radius,0px)] border-b border-line bg-surface px-2 shadow-[var(--scene-chrome-shadow,none)]">
        <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-hidden">
          {engine === "simulated" && (
            <span
              className={cx("inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-[11px] font-bold", TONE_BADGE.warning)}
              title="Escena generada por el motor de reglas, sin IA real: solo para demostración. No proviene del análisis de los videos."
            >
              <FlaskConical className="size-3.5" aria-hidden="true" />
              <span className="hidden @2xl/bar:inline">ESCENA </span>SIMULADA
            </span>
          )}
          {confidence && (
            <span className={cx("inline-flex h-6 shrink-0 items-center rounded-full border px-2 text-[11px] font-semibold", TONE_BADGE[CONFIDENCE_TONE[confidence]])}>
              Confianza {CONFIDENCE_LABEL[confidence]}
            </span>
          )}
          {view && ago && (
            <span className="inline-flex h-6 min-w-0 items-center gap-1 truncate text-[11px] text-muted" title={updatedAt ? `Actualizada ${updatedAt}` : undefined}>
              <Clock className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{ago}</span>
            </span>
          )}
          {updating && view && (
            <span className="inline-flex h-6 shrink-0 items-center gap-1 text-[11px] text-info" role="status">
              <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
              <span className="sr-only @3xl/bar:not-sr-only">Actualizando…</span>
            </span>
          )}
        </div>
        <div className="flex shrink-0 flex-nowrap items-center gap-0.5">
          {view && mode === "3d" && onViewPreset && <ViewMenu onPick={onViewPreset} />}
          {view && !compact && (
            <ToolButton
              onClick={() => togglePanel("layers")}
              active={panel === "layers"}
              pressed={panel === "layers"}
              icon={<Layers className="size-4" aria-hidden="true" />}
              label="Capas"
              showLabel="wide"
            />
          )}
          {view && (
            <ToolButton
              onClick={() => togglePanel("legend")}
              active={panel === "legend"}
              pressed={panel === "legend"}
              icon={<Shapes className="size-4" aria-hidden="true" />}
              label="Simbología"
              showLabel="wide"
            />
          )}
          {view && (
            <ToolButton
              onClick={() => togglePanel("assumptions")}
              active={panel === "assumptions"}
              pressed={panel === "assumptions"}
              icon={<ListChecks className="size-4" aria-hidden="true" />}
              label={`Supuestos${view.scene.uncertaintyNotes.length ? ` (${view.scene.uncertaintyNotes.length})` : ""}`}
              showLabel="wide"
              count={view.scene.uncertaintyNotes.length}
            />
          )}
          {view && onToggleMode && (
            <ToolButton
              onClick={onToggleMode}
              disabled={mode === "2d" && !!toggleDisabledReason}
              title={mode === "2d" && toggleDisabledReason ? toggleDisabledReason : undefined}
              icon={mode === "3d" ? <MapIcon className="size-4" aria-hidden="true" /> : <Rotate3d className="size-4" aria-hidden="true" />}
              label={mode === "3d" ? "Planta 2D" : "Ver en 3D"}
              showLabel="medium"
            />
          )}
        </div>
      </div>

      {notice && (
        <div className="relative z-30 flex items-center gap-2 border-b border-warning/40 bg-warning-soft px-2 py-1 text-[12px] text-warning" role="status">
          <Info className="size-3.5 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1">{notice}</div>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {children}
        {panel === "layers" && (
          <PanelShell title="Capas" onClose={() => setPanel(null)}>
            <LayersPanel layers={layers} onChange={onLayersChange} envStatus={surroundingsStatus} envCount={surroundingsCount} />
          </PanelShell>
        )}
        {panel === "legend" && (
          <PanelShell title="Simbología" onClose={() => setPanel(null)}>
            <LegendPanel />
          </PanelShell>
        )}
        {panel === "assumptions" && (
          <PanelShell title="Supuestos de la reconstrucción" onClose={() => setPanel(null)}>
            <AssumptionsPanel view={view} />
          </PanelShell>
        )}
        {entity && !panel && (
          <Inspector
            entity={entity}
            structureName={structureName}
            onClose={() => onSelect(null)}
            onOpenMedia={onOpenMedia}
            className="absolute right-[calc(var(--scene-hud-r,0px)+0.5rem)] bottom-[calc(var(--scene-hud-b,0px)+0.5rem)] left-[calc(var(--scene-hud-l,0px)+0.5rem)] z-40 max-h-[60%] @2xl:left-auto @2xl:top-[calc(var(--scene-hud-t,0px)+0.5rem)] @2xl:max-h-none @2xl:w-80"
          />
        )}
      </div>

      <footer className="[position:var(--scene-chrome-pos,relative)] right-[var(--scene-safe-r,0px)] bottom-[var(--scene-safe-b,0px)] left-[var(--scene-safe-l,0px)] z-30 flex items-center gap-1.5 rounded-[var(--scene-chrome-radius,0px)] border-t border-line bg-surface px-2 py-1 text-[11px] leading-tight text-muted shadow-[var(--scene-chrome-shadow,none)]">
        <Info className="size-3.5 shrink-0" aria-hidden="true" />
        <span>
          {LEGEND_TEXT}
          {envShown && <span className="text-faint"> · Entorno gris: © OpenStreetMap, referencial</span>}
        </span>
      </footer>
    </section>
  );
}
