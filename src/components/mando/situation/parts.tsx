"use client";
/** Piezas compartidas por la franja crítica y el panel de situación. */
import { useId, useState, type ReactNode } from "react";
import { ChevronDown, CircleAlert, Clock, FileQuestion, MessageSquare, Video, type LucideIcon } from "lucide-react";
import { Spinner, TimeAgo } from "@/components/ui";
import { toneText, type Tone } from "@/components/ui/tone";
import type { CommEntry, EvidenceRef, PipelineState } from "@/lib/domain";
import type { MediaView } from "@/lib/contract";
import { cn } from "@/lib/cn";
import { resolveEvidence, type ResolvedEvidence } from "./evidence";
import { fusionPipelineView } from "./model";

/* ─────────────────────────── Chips de evidencia ─────────────────────────── */

const kindIcon: Record<ResolvedEvidence["kind"], LucideIcon> = {
  media: Video,
  comm: MessageSquare,
  unknown: FileQuestion,
};

interface EvidenceChipProps {
  item: ResolvedEvidence;
  onEvidence?: (ref: EvidenceRef) => void;
  size?: "sm" | "md";
}

function EvidenceChip({ item, onEvidence, size = "sm" }: EvidenceChipProps) {
  const Icon = kindIcon[item.kind];
  const handler = item.state !== "missing" ? onEvidence : undefined;
  const body = (
    <>
      {item.thumbUrl ? (
        // Los fotogramas vienen de /api/files (redirige a URL firmada): next/image no aplica aquí.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={item.thumbUrl}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-5 w-8 shrink-0 rounded-sm border border-line object-cover"
        />
      ) : (
        <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      )}
      <span className="font-mono tabular whitespace-nowrap">{item.label}</span>
    </>
  );
  const base = cn(
    "inline-flex max-w-full items-center gap-1.5 rounded-md border px-1.5",
    size === "md" ? "h-8 text-sm" : "h-7 text-xs",
  );

  if (!handler) {
    const reason = item.description;
    return (
      <span
        role="note"
        title={reason}
        data-evidence-state={item.state}
        className={cn(base, "cursor-not-allowed border-dashed border-line text-faint opacity-60")}
      >
        {body}
        <span className="sr-only">
          {item.state === "missing" ? ` — fuente no disponible: ${reason}` : ` — ${reason}`}
        </span>
      </span>
    );
  }

  return (
    <button
      type="button"
      title={item.description}
      aria-label={`${item.label}: ${item.description}`}
      data-evidence-state={item.state}
      onClick={() => handler(item.ref)}
      className={cn(
        base,
        "border-line bg-surface-2 text-text transition-colors hover:border-line-strong hover:bg-line/50",
      )}
    >
      {body}
    </button>
  );
}

export interface EvidenceChipsProps {
  refs: readonly EvidenceRef[];
  /** Medios y comunicaciones para verificar; si faltan, las referencias no se verifican. */
  media?: readonly MediaView[];
  comms?: readonly CommEntry[];
  onEvidence?: (ref: EvidenceRef) => void;
  size?: "sm" | "md";
  /** Chips visibles antes de plegar el resto en "+N" (sin límite si se omite). */
  max?: number;
  /** Rótulo accesible de la lista. */
  label?: string;
  className?: string;
}

/** Lista de chips de evidencia ("M2 · cuadro 3", "C7"); las fuentes inexistentes quedan atenuadas y sin acción. */
export function EvidenceChips({
  refs,
  media,
  comms,
  onEvidence,
  size,
  max,
  label = "Evidencia",
  className,
}: EvidenceChipsProps) {
  const [showAll, setShowAll] = useState(false);
  if (refs.length === 0) return null;
  const items = refs.map((ref) => resolveEvidence(ref, { media, comms }));
  const folded = max !== undefined && !showAll && items.length > max;
  const visible = folded ? items.slice(0, max) : items;
  const hidden = items.length - visible.length;
  return (
    <ul aria-label={label} className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {visible.map((item, i) => (
        <li key={`${item.label}-${i}`} className="max-w-full">
          <EvidenceChip item={item} onEvidence={onEvidence} size={size} />
        </li>
      ))}
      {hidden > 0 ? (
        <li>
          <button
            type="button"
            onClick={() => setShowAll(true)}
            aria-label={`Ver ${hidden} ${hidden === 1 ? "evidencia más" : "evidencias más"}`}
            className={cn(
              "rounded-md px-1.5 font-medium text-muted transition-colors hover:bg-surface-2 hover:text-text",
              size === "md" ? "h-8 text-sm" : "h-7 text-xs",
            )}
          >
            +{hidden}
          </button>
        </li>
      ) : null}
    </ul>
  );
}

/* ─────────────────────────── Texto plegado ─────────────────────────── */

/** Desde este largo el texto se pliega a 2 líneas y se abre con un clic. */
const CLAMP_CHARS = 100;

/** Párrafo de apoyo en 2 líneas como máximo; un clic lo muestra completo. */
export function ClampText({ text, className }: { text: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const value = text.trim();
  if (!value) return null;
  if (value.length < CLAMP_CHARS) return <p className={className}>{value}</p>;
  return (
    <button
      type="button"
      aria-expanded={open}
      title={open ? "Mostrar menos" : "Mostrar completo"}
      onClick={() => setOpen((v) => !v)}
      className={cn("block w-full cursor-pointer text-left hover:text-text", className)}
    >
      <span className={cn(!open && "line-clamp-2")}>{value}</span>
    </button>
  );
}

/* ─────────────────────────── Estado del análisis ─────────────────────────── */

export interface PipelineStatusLineProps {
  pipeline: PipelineState | null | undefined;
  className?: string;
}

/** "Actualizando análisis…", "En cola" o el error de la fusión; nada si está en reposo. */
export function PipelineStatusLine({ pipeline, className }: PipelineStatusLineProps) {
  const view = fusionPipelineView(pipeline);
  if (!view) return null;
  return (
    <p
      role={view.kind === "error" ? "alert" : "status"}
      data-pipeline={view.kind}
      className={cn("inline-flex min-w-0 items-center gap-1.5 text-sm", toneText[view.tone], className)}
    >
      {view.kind === "running" ? (
        <Spinner size="xs" label="Actualizando" />
      ) : view.kind === "pending" ? (
        <Clock aria-hidden="true" className="size-3.5 shrink-0" />
      ) : (
        <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
      )}
      <span className={cn("min-w-0", view.kind === "error" && "break-words")}>
        {view.kind === "error" ? (
          <>
            <span className="font-semibold">Error del análisis:</span> {view.text}
          </>
        ) : (
          view.text
        )}
      </span>
    </p>
  );
}

/** "Actualizado hace X" (relativo, se refresca solo); nada si no hay fecha. */
export function UpdatedAgo({ iso, className }: { iso: string | null | undefined; className?: string }) {
  if (!iso) return null;
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap text-sm text-muted", className)}>
      Actualizado <TimeAgo iso={iso} />
    </span>
  );
}

/* ─────────────────────────── Sección plegable ─────────────────────────── */

export interface CollapsibleSectionProps {
  title: string;
  icon: LucideIcon;
  open: boolean;
  onToggle: () => void;
  /** Conteo junto al título (se omite si es undefined). */
  count?: number;
  /** Tono del ícono y del conteo (p. ej. crítico si hay hallazgos críticos). */
  tone?: Tone;
  /** Contenido extra a la derecha del encabezado (no interactivo). */
  aside?: ReactNode;
  children: ReactNode;
}

/** Sección con encabezado-botón (aria-expanded) y cuerpo que se oculta sin desmontar el estado del panel. */
export function CollapsibleSection({
  title,
  icon: Icon,
  open,
  onToggle,
  count,
  tone = "neutral",
  aside,
  children,
}: CollapsibleSectionProps) {
  const bodyId = useId();
  return (
    <section className="border-b border-line last:border-b-0">
      <h3 className="m-0">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
          className="flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-surface-2"
        >
          <Icon aria-hidden="true" className={cn("size-4 shrink-0", tone === "neutral" ? "text-muted" : toneText[tone])} />
          <span className="label-caps min-w-0 flex-1 truncate text-sm text-text">{title}</span>
          {aside}
          {count !== undefined ? (
            <span className={cn("tabular min-w-4 text-right text-xs font-semibold", toneText[tone])}>
              <span className="sr-only">Elementos: </span>
              {count}
            </span>
          ) : null}
          <ChevronDown
            aria-hidden="true"
            className={cn("size-4 shrink-0 text-muted transition-transform duration-150", open && "rotate-180")}
          />
        </button>
      </h3>
      <div id={bodyId} hidden={!open} className="px-3 pt-1 pb-3">
        {children}
      </div>
    </section>
  );
}
