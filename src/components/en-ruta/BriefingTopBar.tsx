"use client";

import type { ReactNode } from "react";
import { ShieldAlert, Sun, Timer, WifiOff } from "lucide-react";
import type { BriefingSnapshot } from "@/lib/contract";
import { Elapsed } from "@/components/ui";
import { incidentStatusLabel, incidentTypeIcon, incidentTypeLabel, labelOr } from "@/lib/labels";
import { updatedAgoText } from "./briefing-diff";
import type { WakeLockState } from "./hooks";
import { Pill } from "./parts";

export interface BriefingTopBarProps {
  incident: BriefingSnapshot["incident"];
  stale: boolean;
  lastUpdatedAt: number | null;
  now: number | null;
  wakeLock: WakeLockState;
  /** Aviso de actualización (se pega bajo la barra). */
  children?: ReactNode;
}

/** Barra fija: tipo, dirección, cronómetro desde el aviso, frescura de los datos e insignias de honestidad. */
export function BriefingTopBar({ incident, stale, lastUpdatedAt, now, wakeLock, children }: BriefingTopBarProps) {
  const TypeIcon = incidentTypeIcon[incident.type] ?? ShieldAlert;
  const address = incident.address.trim();
  const ago = updatedAgoText(lastUpdatedAt, now);

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg/95 backdrop-blur supports-[backdrop-filter]:bg-bg/85">
      <div className="mx-auto max-w-[1400px] px-4 pt-3 pb-2.5 lg:px-6">
        <div className="flex items-center gap-2.5">
          <TypeIcon aria-hidden className="size-6 shrink-0 text-accent lg:size-7" strokeWidth={2.25} />
          <p className="label-caps min-w-0 truncate text-base text-text lg:text-lg">
            {labelOr(incidentTypeLabel, incident.type, "Emergencia")}
          </p>
          <p className="ml-auto flex shrink-0 items-center gap-1.5 text-text" title="Tiempo desde el aviso">
            <Timer aria-hidden className="size-5 text-muted" />
            <span className="sr-only">Tiempo desde el aviso:</span>
            <Elapsed since={incident.created_at} className="text-xl font-semibold lg:text-2xl" />
          </p>
        </div>

        <h1 className="mt-1 line-clamp-2 font-display text-2xl leading-tight font-bold text-text sm:text-3xl lg:text-4xl">
          {address || incident.title || "Dirección por confirmar"}
        </h1>
        <p className="mt-0.5 truncate text-base text-muted lg:text-lg">
          <span className="font-mono text-text">{incident.code}</span>
          {address && incident.title && <> · {incident.title}</>}
        </p>

        <div className="mt-2 flex flex-wrap items-center gap-2" aria-live="polite">
          {stale ? (
            <Pill tone="warning" icon={WifiOff}>
              Sin señal — mostrando la última información
            </Pill>
          ) : (
            ago && (
              <span className="inline-flex items-center gap-1.5 text-base text-muted">
                <span aria-hidden className="size-2 rounded-full bg-ok" />
                {ago}
              </span>
            )
          )}
          {!incident.verified && <Pill tone="neutral">SIN VERIFICAR</Pill>}
          {incident.status !== "active" && (
            <Pill tone={incident.status === "closed" ? "critical" : "info"}>
              {labelOr(incidentStatusLabel, incident.status).toUpperCase()}
            </Pill>
          )}
          {wakeLock === "on" && (
            <span
              className="ml-auto inline-flex items-center gap-1 text-sm text-muted"
              title="La pantalla se mantiene encendida mientras esta página está abierta"
            >
              <Sun aria-hidden className="size-4" />
              Pantalla encendida
            </span>
          )}
        </div>
      </div>
      {children}
    </header>
  );
}
