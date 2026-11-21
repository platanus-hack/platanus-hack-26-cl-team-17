"use client";

import { useMemo } from "react";
import { Video } from "lucide-react";
import type { MediaView, RuntimeMode } from "@/lib/contract";
import { ConfidenceMeter, EmptyState } from "@/components/ui";
import { SimulatedNotice } from "@/components/shell";
import { cn } from "@/lib/cn";
import { mediaSourceLabel, mediaStatusLabel } from "@/lib/labels";
import { MediaThumb } from "./MediaThumb";
import { mediaStatusBusy, sortMediaForStrip } from "./media-utils";
import type { MediaViewerTarget } from "./types";

/** Props de `MediaGrid`. */
export interface MediaGridProps {
  media: MediaView[];
  onOpen: (target: MediaViewerTarget) => void;
  /** Modo de la instancia y si el incidente es de demostración: ajustan el aviso de simulación. */
  mode?: RuntimeMode | null;
  demo?: boolean;
  className?: string;
}

function summaryOf(m: MediaView): string {
  const a = m.analysis;
  if (a) {
    if (!a.usable) return a.unusable_reason ? `Imágenes no utilizables: ${a.unusable_reason}` : "Imágenes no utilizables.";
    return a.summary || "Sin resumen.";
  }
  if (m.status === "failed") return m.error ? `Falló el análisis: ${m.error}` : "Falló el análisis.";
  if (mediaStatusBusy(m.status)) return `${mediaStatusLabel[m.status]}…`;
  return "Sin análisis aún.";
}

/** Grilla de todos los medios del incidente con su resumen de análisis; clic abre el visor. */
export function MediaGrid({ media, onOpen, mode = null, demo = false, className }: MediaGridProps) {
  const ordered = useMemo(() => sortMediaForStrip(media), [media]);

  if (ordered.length === 0) {
    return (
      <div className={cn("flex h-full min-h-0 items-center justify-center", className)}>
        <EmptyState
          icon={Video}
          title="Aún no hay medios"
          description="Comparte el enlace con vecinos o usa «Agregar video» para un video recibido por otra vía."
        />
      </div>
    );
  }

  return (
    <div className={cn("h-full min-h-0 overflow-y-auto", className)}>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3 p-1">
        {ordered.map((m) => (
          <li key={m.id} className="flex min-w-0 flex-col gap-1.5">
            <MediaThumb media={m} size="md" onClick={() => onOpen({ mediaId: m.id })} />
            <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
              <span className="font-mono font-semibold text-text">{m.label}</span>
              <span className="truncate">{mediaSourceLabel[m.source]}</span>
              {m.analysis && <ConfidenceMeter level={m.analysis.confidence} size="sm" className="ml-auto" />}
            </div>
            <p className={cn("line-clamp-2 text-sm leading-snug", m.status === "failed" ? "text-critical" : "text-text")}>
              {summaryOf(m)}
            </p>
            {m.analysis && m.analysis_engine === "simulated" && (
              <SimulatedNotice compact what="Este análisis" mode={mode} demo={demo || m.source === "demo"} />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
