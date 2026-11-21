"use client";

import { CircleAlert, ImageOff, Siren } from "lucide-react";
import type { MediaView } from "@/lib/contract";
import { Spinner } from "@/components/ui";
import { cn } from "@/lib/cn";
import { formatClock } from "@/lib/format";
import { mediaSourceIcon, mediaSourceLabel, mediaStatusLabel } from "@/lib/labels";
import { mediaHasPeopleAtRisk, mediaStatusBusy, mediaTime, posterUrl } from "./media-utils";

/** Props de `MediaThumb`. */
export interface MediaThumbProps {
  media: MediaView;
  selected?: boolean;
  onClick: () => void;
  size?: "sm" | "md";
  className?: string;
}

/** Miniatura de un medio: póster, etiqueta M<n>, fuente, hora, estado y marcador de personas en riesgo. */
export function MediaThumb({ media, selected = false, onClick, size = "sm", className }: MediaThumbProps) {
  const poster = posterUrl(media);
  const busy = mediaStatusBusy(media.status);
  const failed = media.status === "failed";
  const atRisk = mediaHasPeopleAtRisk(media);
  const SourceIcon = mediaSourceIcon[media.source];
  const time = formatClock(mediaTime(media));
  const sm = size === "sm";

  const ariaLabel = [
    `Abrir ${media.label}`,
    mediaSourceLabel[media.source],
    time,
    mediaStatusLabel[media.status],
    atRisk ? "personas en riesgo" : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      aria-current={selected ? "true" : undefined}
      data-media-id={media.id}
      className={cn(
        // animate-enter corre solo al montar: con clave estable por id no se repite en cada sondeo.
        "group relative block shrink-0 animate-enter overflow-hidden rounded-md border bg-surface-2 text-left",
        "transition-colors hover:border-line-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        selected ? "border-accent ring-1 ring-accent" : atRisk ? "border-critical/60" : "border-line",
        sm ? "h-[72px] w-32" : "aspect-video w-full",
        className,
      )}
    >
      {poster ? (
        // eslint-disable-next-line @next/next/no-img-element -- URLs de /api/files con redirección firmada; next/image no aplica
        <img
          src={poster}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          className="absolute inset-0 size-full object-cover"
        />
      ) : (
        <span aria-hidden className="absolute inset-0 grid place-items-center text-faint">
          <ImageOff className={sm ? "size-5" : "size-8"} />
        </span>
      )}

      {/* Franja superior: etiqueta y marcador de riesgo */}
      <span aria-hidden className="absolute inset-x-0 top-0 flex items-start justify-between gap-1 p-1">
        <span className="rounded-sm bg-bg/85 px-1 font-mono text-[11px] leading-4 font-semibold text-text tabular">
          {media.label}
        </span>
        {atRisk && (
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-sm bg-critical px-1 leading-4 font-semibold text-on-solid",
              sm ? "text-[10px]" : "text-xs",
            )}
            title={
              media.analysis_engine === "simulated"
                ? "El análisis (simulado) indica personas en riesgo"
                : "El análisis ve personas en riesgo"
            }
          >
            <Siren className={cn("shrink-0 animate-pulse-critical", sm ? "size-2.5" : "size-3")} />
            {sm ? "RIESGO" : "PERSONAS EN RIESGO"}
          </span>
        )}
      </span>

      {/* Franja inferior: fuente, hora y estado */}
      <span
        aria-hidden
        className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-bg/85 px-1 py-0.5 text-[11px] leading-4 text-muted"
      >
        <SourceIcon className="size-3 shrink-0" />
        <span className="tabular">{time}</span>
        <span className="ml-auto inline-flex items-center gap-1">
          {busy && <Spinner size="xs" label={mediaStatusLabel[media.status]} />}
          {failed && <CircleAlert className="size-3.5 text-critical" />}
          {!sm && (busy || failed) && (
            <span className={failed ? "text-critical" : undefined}>{mediaStatusLabel[media.status]}</span>
          )}
        </span>
      </span>
      {atRisk && <span className="sr-only">personas en riesgo</span>}
    </button>
  );
}
