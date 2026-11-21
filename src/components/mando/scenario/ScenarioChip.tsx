"use client";

import { usePathname } from "next/navigation";
import { CircleAlert, CircleCheck, Eye, FlaskConical, Square, X } from "lucide-react";
import { Badge, Button, StatusDot } from "@/components/ui";
import { cn } from "@/lib/cn";
import type { ScenarioState } from "./ScenarioProvider";

/** Props de `ScenarioChip`. */
export interface ScenarioChipProps {
  scenario: ScenarioState;
  /** Cierra el aviso de error o de término (no detiene un simulacro en curso). */
  onDismiss: () => void;
  /** "floating" = chip fijo abajo a la izquierda; "inline" = franja a todo el ancho dentro de la página. */
  variant?: "floating" | "inline";
  className?: string;
}

/** true si hay algo que mostrar del simulacro (en curso, terminado o detenido por error). */
export function scenarioVisible(s: Pick<ScenarioState, "running" | "finished" | "error">): boolean {
  return s.running || s.finished || s.error !== null;
}

/** Avance del simulacro con enlace al incidente y Detener/Cerrar: chip flotante o franja en línea. */
export function ScenarioChip({ scenario, onDismiss, variant = "floating", className }: ScenarioChipProps) {
  const pathname = usePathname();
  const { running, incidentId, step, total, label, error, finished, stop } = scenario;
  const href = incidentId ? "/mando/" + incidentId : null;
  const showLink = href !== null && pathname !== href;
  const failed = error !== null;

  let status: string;
  if (failed) status = "Simulacro detenido por un error";
  else if (finished) status = "Simulacro terminado";
  else if (step === 0) status = "Iniciando…";
  else status = `paso ${step}/${total ?? "?"}${label ? " · " + label : ""}`;

  return (
    <div
      role="region"
      aria-label="Simulacro en vivo"
      title="Simulacro con datos ficticios"
      className={cn(
        "flex flex-wrap items-center gap-x-3",
        variant === "floating"
          ? "animate-enter fixed bottom-4 left-4 z-40 max-w-[calc(100vw-2rem)] gap-y-2 rounded-lg border bg-surface px-3 py-2 sm:max-w-xl"
          : "gap-y-1 border-b px-3 py-1 md:px-4",
        variant === "floating"
          ? failed
            ? "border-critical/60"
            : "border-warning/50"
          : failed
            ? "border-critical/40 bg-critical-soft"
            : "border-warning/40 bg-warning-soft",
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {failed ? (
          <Badge tone="critical" icon={CircleAlert} size="md">
            Simulacro
          </Badge>
        ) : (
          <Badge tone="warning" icon={FlaskConical} size="md">
            Simulacro
          </Badge>
        )}
        {running ? <StatusDot tone="warning" pulse label="En curso" /> : null}
        {finished && !failed ? (
          <CircleCheck aria-hidden="true" size={16} className="shrink-0 text-ok" />
        ) : null}
        <div className="min-w-0" aria-live="polite" aria-atomic="true">
          <p className={cn("truncate text-sm", failed ? "font-semibold text-critical" : "text-text")}>
            <span className="tabular">{status}</span>
          </p>
          {failed ? <p className="text-xs break-words text-muted">{error}</p> : null}
          <p className="sr-only">Datos ficticios.</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {showLink ? (
          <Button size="sm" variant="ghost" icon={Eye} href={href}>
            Ver
          </Button>
        ) : null}
        {running ? (
          <Button size="sm" variant="secondary" icon={Square} onClick={stop}>
            Detener
          </Button>
        ) : (
          <Button size="sm" variant="secondary" icon={X} onClick={onDismiss}>
            Cerrar
          </Button>
        )}
      </div>
    </div>
  );
}
