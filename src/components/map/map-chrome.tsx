"use client";
/** Controles y avisos superpuestos al mapa (fuera del div de MapLibre, que no admite hijos). */
import type { ReactNode } from "react";
import { ImageOff, Loader2, MapPinOff, Minus, Plus } from "lucide-react";
import type { Map as MapLibreMap } from "maplibre-gl";
import { cn } from "@/lib/cn";
import type { BaseMapState } from "./use-maplibre";

export type Tone = "critical" | "accent" | "warning" | "info" | "ok" | "drone" | "neutral";

/** Relleno sólido por tono (clases literales para que Tailwind las detecte). */
export const TONE_SOLID: Record<Tone, string> = {
  critical: "bg-critical text-on-solid",
  accent: "bg-accent text-on-solid",
  warning: "bg-warning text-on-solid",
  info: "bg-info text-on-solid",
  ok: "bg-ok text-on-solid",
  drone: "bg-drone text-on-solid",
  neutral: "bg-surface-2 text-text",
};

export const TONE_TEXT: Record<Tone, string> = {
  critical: "text-critical",
  accent: "text-accent",
  warning: "text-warning",
  info: "text-info",
  ok: "text-ok",
  drone: "text-drone",
  neutral: "text-muted",
};

export const TONE_BG: Record<Tone, string> = {
  critical: "bg-critical",
  accent: "bg-accent",
  warning: "bg-warning",
  info: "bg-info",
  ok: "bg-ok",
  drone: "bg-drone",
  neutral: "bg-muted",
};

export function MapButton({
  label,
  onClick,
  children,
  large,
  disabled,
  showLabel,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  large?: boolean;
  disabled?: boolean;
  /** Muestra el texto junto al icono (además del aria-label). */
  showLabel?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={showLabel ? undefined : label}
      title={label}
      className={cn(
        "pointer-events-auto inline-flex items-center justify-center gap-1.5 rounded-control border border-line bg-surface/90 text-text shadow-md backdrop-blur-sm transition-colors hover:bg-surface-2 disabled:opacity-50",
        large ? "min-h-11 min-w-11 text-base" : "min-h-9 min-w-9 text-sm pointer-coarse:min-h-11 pointer-coarse:min-w-11",
        showLabel && "px-3 font-semibold",
      )}
    >
      {children}
      {showLabel && <span>{label}</span>}
    </button>
  );
}

export function ZoomControls({ map, large }: { map: MapLibreMap | null; large?: boolean }) {
  const icon = large ? "size-5" : "size-4";
  return (
    <div className="flex flex-col gap-1">
      <MapButton label="Acercar" large={large} disabled={!map} onClick={() => map?.zoomIn()}>
        <Plus className={icon} aria-hidden />
      </MapButton>
      <MapButton label="Alejar" large={large} disabled={!map} onClick={() => map?.zoomOut()}>
        <Minus className={icon} aria-hidden />
      </MapButton>
    </div>
  );
}

/** Aviso discreto cuando no hay teselas: el mapa sigue mostrando los marcadores sobre fondo liso. */
export function BaseMapNotice({ base, className }: { base: BaseMapState; className?: string }) {
  if (base !== "unavailable") return null;
  return (
    <div
      role="status"
      className={cn(
        "pointer-events-none inline-flex items-center gap-1.5 rounded-control border border-line bg-surface/90 px-2 py-1 text-xs text-muted shadow-sm",
        className,
      )}
    >
      <ImageOff className="size-3.5 shrink-0" aria-hidden />
      Mapa base no disponible
    </div>
  );
}

/** Velo mientras carga el primer estilo (el contenedor ya tiene su tamaño final). */
export function LoadingVeil({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div
      role="status"
      className="pointer-events-none absolute inset-0 grid place-items-center bg-surface-2/60 animate-fade-in"
    >
      <span className="inline-flex items-center gap-2 rounded-control bg-surface/90 px-3 py-1.5 text-xs text-muted shadow-sm">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        Cargando mapa…
      </span>
    </div>
  );
}

/** El mapa no se pudo crear (p. ej. sin WebGL): mensaje en lugar del lienzo. */
export function MapFatalError({ message, detail }: { message: string; detail?: ReactNode }) {
  return (
    <div role="alert" className="absolute inset-0 grid place-items-center bg-surface-2 p-4 text-center">
      <div className="max-w-sm space-y-2">
        <MapPinOff className="mx-auto size-6 text-muted" aria-hidden />
        <p className="text-sm text-text">{message}</p>
        {detail && <div className="text-xs text-muted">{detail}</div>}
      </div>
    </div>
  );
}

/**
 * Contenido de un marcador informativo: icono redondo con detalle que aparece al pasar
 * el puntero o al enfocar con teclado (el texto completo va también en aria-label).
 */
export function MarkerTip({
  children,
  open = false,
  side = "top",
}: {
  children: ReactNode;
  /** Fijo abierto (tocado); si no, aparece con hover o foco de teclado del `group`. */
  open?: boolean;
  side?: "top" | "bottom";
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute left-1/2 z-10 w-max max-w-56 -translate-x-1/2 rounded-control border border-line bg-surface px-2 py-1 text-left text-xs leading-snug text-text shadow-lg",
        open ? "block" : "hidden group-hover:block group-focus-visible:block",
        side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5",
      )}
    >
      {children}
    </span>
  );
}
