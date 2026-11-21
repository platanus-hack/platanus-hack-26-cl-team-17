"use client";
/**
 * Banda de estado de la vista técnica: un rótulo por subsistema con su color (verde = bien,
 * ámbar = atención, rojo = fallando, gris = no se usa) y un texto corto. Tocar uno abre el
 * detalle en esa sección. Siempre visible bajo la barra del mando.
 */
import { Activity, ChevronDown, ChevronUp, WifiOff } from "lucide-react";
import { Button, Spinner, StatusDot, type Tone } from "@/components/ui";
import { cn } from "@/lib/cn";
import type { DiagTone, SubsystemId, SubsystemStatus } from "./model";

/** Tono de la UI para cada estado del diagnóstico. */
export const DIAG_TONE: Record<DiagTone, Tone> = { ok: "ok", warning: "warning", critical: "critical", muted: "neutral" };

const CHIP: Record<DiagTone, string> = {
  ok: "border-ok/40 bg-ok-soft",
  warning: "border-warning/40 bg-warning-soft",
  critical: "border-critical/60 bg-critical-soft",
  muted: "border-line bg-surface-2",
};

const VALUE: Record<DiagTone, string> = {
  ok: "text-text",
  warning: "text-warning",
  critical: "text-critical",
  muted: "text-muted",
};

const TONE_WORD: Record<DiagTone, string> = { ok: "bien", warning: "atención", critical: "fallando", muted: "sin uso" };

export interface DiagnosticsBandProps {
  /** null hasta la primera respuesta. */
  items: SubsystemStatus[] | null;
  /** El sondeo del diagnóstico no responde (los datos pueden estar viejos). */
  offline: { since: string | null; message: string } | null;
  open: boolean;
  onOpen: (focus: SubsystemId | null) => void;
  onClose: () => void;
  className?: string;
}

export function DiagnosticsBand({ items, offline, open, onOpen, onClose, className }: DiagnosticsBandProps) {
  return (
    <div
      role="region"
      aria-label="Estado de los sistemas"
      className={cn("flex shrink-0 items-start gap-2 border-b border-line bg-bg px-2 py-1.5 sm:px-3", className)}
    >
      <span className="hidden h-8 shrink-0 items-center gap-1.5 text-xs font-semibold text-muted lg:inline-flex">
        <Activity aria-hidden className="size-3.5" />
        Sistemas
      </span>
      {/* En teléfono, dos por fila; desde sm, en línea (y a una segunda fila si no caben). */}
      <ul className="grid min-w-0 flex-1 grid-cols-2 gap-1.5 sm:flex sm:flex-wrap sm:items-center" aria-live="polite">
        {offline && (
          <li className="col-span-2 min-w-0 shrink-0">
            <span
              role="status"
              title={offline.message}
              className="flex h-8 items-center gap-1.5 rounded-lg border border-critical/60 bg-critical-soft px-2.5 text-xs font-semibold text-critical"
            >
              <WifiOff aria-hidden className="size-3.5" />
              Sin datos del servidor{offline.since ? ` ${offline.since}` : ""}
            </span>
          </li>
        )}
        {items === null ? (
          <li className="col-span-2 flex h-8 shrink-0 items-center gap-2 px-2 text-xs text-muted">
            <Spinner size="xs" label="Cargando el estado" />
            Revisando los sistemas…
          </li>
        ) : (
          items.map((s) => (
            <li key={s.id} className="min-w-0 shrink-0">
              <button
                type="button"
                onClick={() => onOpen(s.id)}
                title={s.hint}
                className={cn(
                  "flex h-8 w-full items-center gap-2 rounded-lg border px-2.5 text-left transition-colors hover:border-line-strong sm:w-auto sm:max-w-[22rem]",
                  CHIP[s.tone],
                )}
              >
                <StatusDot tone={DIAG_TONE[s.tone]} pulse={s.tone === "critical"} />
                <span className="label-caps shrink-0 text-[11px] text-muted">{s.label}</span>
                <span className={cn("min-w-0 truncate text-xs font-semibold tabular", VALUE[s.tone])} suppressHydrationWarning>
                  {s.value}
                </span>
                <span className="sr-only">
                  ({TONE_WORD[s.tone]}). {s.hint}
                </span>
              </button>
            </li>
          ))
        )}
      </ul>
      <Button
        size="sm"
        variant={open ? "primary" : "secondary"}
        icon={open ? ChevronUp : ChevronDown}
        onClick={() => (open ? onClose() : onOpen(null))}
        aria-expanded={open}
        className="shrink-0"
      >
        <span className="sm:hidden">{open ? "Operación" : "Detalle"}</span>
        <span className="max-sm:hidden">{open ? "Volver a la operación" : "Ver detalle"}</span>
      </Button>
    </div>
  );
}
