"use client";

import { useEffect, useMemo, useRef } from "react";
import { Video } from "lucide-react";
import type { MediaView } from "@/lib/contract";
import { cn } from "@/lib/cn";
import { MediaThumb } from "./MediaThumb";
import { mediaHasPeopleAtRisk, sortMediaForStrip } from "./media-utils";
import type { MediaViewerTarget } from "./types";

/** Props de `MediaStrip`. */
export interface MediaStripProps {
  media: MediaView[];
  selectedId?: string | null;
  onOpen: (target: MediaViewerTarget) => void;
  className?: string;
}

/** Tira horizontal de medios M1..Mn, siempre visible bajo la vista central; clic abre el visor. */
export function MediaStrip({ media, selectedId = null, onOpen, className }: MediaStripProps) {
  const ordered = useMemo(() => sortMediaForStrip(media), [media]);
  const atRisk = useMemo(() => ordered.filter(mediaHasPeopleAtRisk).length, [ordered]);
  const listRef = useRef<HTMLUListElement>(null);

  // Lleva el medio seleccionado a la vista sin mover la página.
  useEffect(() => {
    if (!selectedId) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-media-id="${CSS.escape(selectedId)}"]`);
    el?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [selectedId]);

  return (
    <section
      aria-label="Tira de medios"
      className={cn("flex min-w-0 items-center gap-2 rounded-lg border border-line bg-surface px-2 py-1.5", className)}
    >
      <div className="flex shrink-0 flex-col items-start gap-0.5 pr-1">
        <span className="label-caps flex items-center gap-1 text-xs text-muted">
          <Video aria-hidden className="size-3.5" />
          Medios
        </span>
        <span className="text-sm font-semibold text-text tabular">{ordered.length}</span>
        {atRisk > 0 && (
          <span className="text-[11px] leading-3 font-semibold text-critical">{atRisk} con riesgo</span>
        )}
      </div>

      {ordered.length === 0 ? (
        <p className="min-w-0 py-5 text-sm text-muted">Aún no hay medios · comparte el enlace con vecinos</p>
      ) : (
        <ul
          ref={listRef}
          className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto overscroll-x-contain p-0.5 [scrollbar-width:thin]"
        >
          {ordered.map((m) => (
            <li key={m.id} className="shrink-0">
              <MediaThumb media={m} size="sm" selected={m.id === selectedId} onClick={() => onOpen({ mediaId: m.id })} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
