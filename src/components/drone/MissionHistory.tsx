"use client";

import { ChevronRight } from "lucide-react";
import { KeyValue } from "@/components/ui";
import type { MediaView } from "@/lib/contract";
import type { DroneMission } from "@/lib/domain";
import { formatClock, formatDuration, pluralize } from "@/lib/format";
import { missionModeLabel, missionPatternLabel, missionStatusIcon, missionStatusLabel, missionStatusTone } from "@/lib/labels";
import { toneText } from "@/components/ui/tone";
import { cn } from "@/lib/cn";
import { BatchList } from "./BatchList";
import { droneBatchesFor } from "./model";

export interface MissionHistoryProps {
  missions: DroneMission[];
  media: MediaView[];
  onOpenMedia?: (mediaLabel: string) => void;
  className?: string;
}

function durationS(m: DroneMission): number | null {
  if (!m.started_at || !m.ended_at) return null;
  const s = (Date.parse(m.ended_at) - Date.parse(m.started_at)) / 1000;
  return Number.isFinite(s) && s >= 0 ? s : null;
}

/** Misiones terminadas, plegables: resumen en una línea y, al abrir, datos y lotes. */
export function MissionHistory({ missions, media, onOpenMedia, className }: MissionHistoryProps) {
  if (missions.length === 0) return null;
  return (
    <section aria-label="Misiones terminadas" className={cn("flex flex-col gap-2", className)}>
      <h3 className="label-caps text-xs text-muted">Historial · {pluralize(missions.length, "misión", "misiones")}</h3>
      <ul className="flex flex-col gap-1.5">
        {missions.map((m) => {
          const Icon = missionStatusIcon[m.status];
          const batches = droneBatchesFor(media, m.id);
          const dur = durationS(m);
          return (
            <li key={m.id}>
              <details className="group rounded-md border border-line bg-surface-2/40">
                <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2.5 py-2 text-sm hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
                  <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-faint transition-transform group-open:rotate-90" />
                  <span className="font-display text-base font-semibold text-text">{m.label}</span>
                  <span className={cn("flex items-center gap-1", toneText[missionStatusTone[m.status]])}>
                    <Icon aria-hidden="true" className="size-3.5" />
                    {missionStatusLabel[m.status]}
                  </span>
                  <span className="ml-auto truncate text-xs text-muted">
                    {missionModeLabel[m.mode]} · {pluralize(m.frames_received, "cuadro")}
                  </span>
                </summary>
                <div className="flex flex-col gap-3 border-t border-line p-2.5">
                  <KeyValue
                    dense
                    columns={2}
                    items={[
                      { label: "Patrón", value: missionPatternLabel[m.pattern] },
                      { label: "Altura", value: `${Math.round(m.altitude_m)} m` },
                      { label: "Despegue", value: m.started_at ? formatClock(m.started_at) : "No despegó", mono: true },
                      { label: "Fin", value: m.ended_at ? formatClock(m.ended_at) : "—", mono: true },
                      { label: "Duración", value: formatDuration(dur) },
                      { label: "Lotes", value: String(batches.length) },
                    ]}
                  />
                  {m.mode === "simulated" && (
                    <p className="text-xs text-warning">Misión SIMULADA: telemetría generada, sin cámara.</p>
                  )}
                  <BatchList batches={batches} onOpenMedia={onOpenMedia} />
                </div>
              </details>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
