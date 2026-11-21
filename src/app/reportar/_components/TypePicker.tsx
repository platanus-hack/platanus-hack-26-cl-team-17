"use client";

import { ChevronRight } from "lucide-react";
import type { IncidentType } from "@/lib/domain";
import { incidentTypeIcon, incidentTypeLabel } from "@/lib/labels";

/** Opciones para vecinos, con palabras simples (no las etiquetas técnicas del puesto de mando). */
export const REPORT_TYPE_OPTIONS: readonly { type: IncidentType; label: string }[] = [
  { type: "structure_fire", label: "Incendio en casa o edificio" },
  { type: "vehicle_fire", label: "Vehículo en llamas" },
  { type: "wildland_fire", label: "Incendio de pastizal o forestal" },
  { type: "vehicle_collision", label: "Choque o accidente de tránsito" },
  { type: "other", label: "Otra" },
];

/** Nombre del tipo en palabras de vecino; los tipos que no se ofrecen usan la etiqueta general. */
export function reportTypeLabel(type: IncidentType): string {
  const option = REPORT_TYPE_OPTIONS.find((o) => o.type === type);
  if (!option) return incidentTypeLabel[type];
  return type === "other" ? "Otra emergencia" : option.label;
}

export interface TypePickerProps {
  onPick: (type: IncidentType) => void;
  /** id del encabezado que nombra la lista (accesibilidad). */
  labelledBy: string;
}

/** Botones grandes, uno por tipo de emergencia. */
export function TypePicker({ onPick, labelledBy }: TypePickerProps) {
  return (
    <ul aria-labelledby={labelledBy} className="flex flex-col gap-2.5">
      {REPORT_TYPE_OPTIONS.map(({ type, label }) => {
        const Icon = incidentTypeIcon[type];
        return (
          <li key={type}>
            <button
              type="button"
              onClick={() => onPick(type)}
              className="flex min-h-16 w-full items-center gap-3.5 rounded-lg border border-line-strong bg-surface px-4 py-3 text-left text-lg leading-tight font-semibold text-text transition-colors hover:border-accent hover:bg-surface-2 active:bg-line/60"
            >
              <span className="flex size-11 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
                <Icon aria-hidden className="size-6" strokeWidth={2.25} />
              </span>
              <span className="min-w-0 flex-1">{label}</span>
              <ChevronRight aria-hidden className="size-5 shrink-0 text-muted" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
