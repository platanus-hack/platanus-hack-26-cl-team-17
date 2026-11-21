"use client";
/**
 * Marco de cada mapa: fija el tamaño (className del llamador o un alto por defecto) y el tema
 * de los tokens (oscuro = "mando", claro = "vecino") para que marcadores, leyenda y colores de
 * las capas combinen con el mapa base. No importa maplibre: se carga en el primer render.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Map as MapIcon, MapPinOff, RotateCcw } from "lucide-react";
import { cn } from "@/lib/cn";
import type { MapTheme } from "./types";

export function MapFrame({
  theme = "dark",
  className,
  defaultSize,
  label,
  children,
}: {
  theme?: MapTheme;
  className?: string;
  /** Alto por defecto si el llamador no entrega className. */
  defaultSize: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div
      role="region"
      aria-label={label}
      data-theme={theme === "light" ? "vecino" : "mando"}
      className={cn("relative isolate overflow-hidden", className ?? defaultSize)}
    >
      <MapErrorBoundary>{children}</MapErrorBoundary>
    </div>
  );
}

/**
 * Esqueleto del mismo tamaño que el mapa mientras se descarga el código de MapLibre.
 * (En el App Router, next/dynamic no entrega `error` al cargador: lo atrapa MapErrorBoundary.)
 */
export function MapLoading() {
  return (
    <div role="status" className="absolute inset-0 overflow-hidden bg-surface-2">
      <div className="absolute inset-0 animate-pulse bg-[linear-gradient(110deg,transparent_30%,var(--color-surface)_50%,transparent_70%)] opacity-60" />
      <div className="absolute inset-0 grid place-items-center">
        <span className="inline-flex items-center gap-2 text-xs text-muted">
          <MapIcon className="size-4" aria-hidden />
          Cargando mapa…
        </span>
      </div>
    </div>
  );
}

/** Si el mapa falla (código que no descargó, error de MapLibre), el resto de la página sigue en pie. */
class MapErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn("[mapa] el mapa falló y se ocultó", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="absolute inset-0 grid place-items-center bg-surface-2 p-4 text-center">
        <div className="max-w-sm space-y-2">
          <MapPinOff className="mx-auto size-6 text-muted" aria-hidden />
          <p className="text-sm text-text">No se pudo mostrar el mapa.</p>
          <p className="text-xs text-muted">El resto de la información sigue disponible.</p>
          <button
            type="button"
            onClick={() => this.setState({ failed: false })}
            className={cn(
              "inline-flex min-h-9 items-center gap-1.5 rounded-control border border-line bg-surface px-3 text-sm font-semibold text-text hover:bg-surface-2",
              "pointer-coarse:min-h-11",
            )}
          >
            <RotateCcw className="size-4" aria-hidden />
            Reintentar
          </button>
        </div>
      </div>
    );
  }
}
