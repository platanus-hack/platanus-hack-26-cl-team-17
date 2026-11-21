"use client";

import { useState } from "react";
import { CircleAlert, Images, Info } from "lucide-react";
import { Badge, Button, ConfidenceMeter, Spinner, TimeAgo } from "@/components/ui";
import { SimulatedNotice } from "@/components/shell";
import type { MediaView } from "@/lib/contract";
import { mediaStatusLabel, mediaStatusTone } from "@/lib/labels";
import { pluralize } from "@/lib/format";
import { cn } from "@/lib/cn";
import { batchDigest, batchThumbUrl } from "./model";

/** Lotes que se muestran antes de "Ver todos". */
const VISIBLE_BATCHES = 3;

export interface BatchListProps {
  /** Lotes del dron, el más reciente primero. */
  batches: MediaView[];
  onOpenMedia?: (mediaLabel: string) => void;
  className?: string;
}

function BatchThumb({ media }: { media: MediaView }) {
  const url = batchThumbUrl(media);
  if (!url) {
    return (
      <span className="flex h-12 w-20 shrink-0 items-center justify-center rounded border border-line bg-surface-2">
        <Images aria-hidden="true" className="size-4 text-faint" />
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- archivo servido por /api/files (local o URL firmada)
    <img
      src={url}
      alt={`Primer cuadro del lote ${media.label}`}
      loading="lazy"
      className="h-12 w-20 shrink-0 rounded border border-line bg-surface-2 object-cover"
    />
  );
}

function BatchItem({ media, onOpenMedia }: { media: MediaView; onOpenMedia?: (label: string) => void }) {
  const d = batchDigest(media);
  const head = (
    <>
      <BatchThumb media={media} />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-display text-base font-semibold text-text">{media.label}</span>
          <span className="text-xs text-muted tabular">{pluralize(media.frames.length, "cuadro")}</span>
          <Badge tone={mediaStatusTone[media.status]} size="sm" dot={d.phase === "analyzing"} pulse={d.phase === "analyzing"}>
            {mediaStatusLabel[media.status]}
          </Badge>
        </span>
        <span className={cn("line-clamp-3 text-sm leading-snug", d.phase === "failed" ? "text-critical" : "text-muted")}>
          {d.phase === "analyzing" && <Spinner size="xs" label="Analizando" className="mr-1.5 inline-block align-[-2px]" />}
          {d.phase === "failed" && <CircleAlert aria-hidden="true" className="mr-1 inline size-3.5 align-[-2px]" />}
          {d.text}
        </span>
        <span className="text-[11px] text-faint">
          {media.captured_at ? <TimeAgo iso={media.captured_at} /> : <TimeAgo iso={media.created_at} />}
        </span>
      </span>
    </>
  );
  return (
    <li className="flex flex-col gap-2 rounded-md border border-line bg-surface-2/40 p-2">
      {onOpenMedia ? (
        <button
          type="button"
          onClick={() => onOpenMedia(media.label)}
          className="-m-1 flex items-start gap-2.5 rounded-md p-1 text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          aria-label={`Abrir el lote ${media.label} del dron (${pluralize(media.frames.length, "cuadro")})`}
        >
          {head}
        </button>
      ) : (
        <div className="flex items-start gap-2.5">{head}</div>
      )}
      {d.phase === "analyzed" && media.analysis && (
        <div className="flex flex-col gap-1.5">
          {d.chips.length > 0 && (
            <ul className="flex flex-wrap gap-1" aria-label={`Hallazgos de la IA en ${media.label}`}>
              {d.chips.map((c, i) => (
                <li key={`${c.text}-${i}`}>
                  <Badge tone={c.tone} size="sm">
                    {c.text}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
          {d.noPeopleNote && (
            <p className="flex items-start gap-1.5 text-xs text-warning">
              <Info aria-hidden="true" className="mt-px size-3.5 shrink-0" />
              {d.noPeopleNote}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <ConfidenceMeter level={media.analysis.confidence} size="sm" />
            {media.analysis_engine === "simulated" && <SimulatedNotice compact what="Este análisis" />}
          </div>
        </div>
      )}
    </li>
  );
}

/** Lotes de cuadros que envió un dron y lo que la IA vio en cada uno. */
export function BatchList({ batches, onOpenMedia, className }: BatchListProps) {
  const [showAll, setShowAll] = useState(false);
  if (batches.length === 0) return null;
  const visible = showAll ? batches : batches.slice(0, VISIBLE_BATCHES);
  const hidden = batches.length - visible.length;
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <ul className="flex flex-col gap-2">
        {visible.map((m) => (
          <BatchItem key={m.id} media={m} onOpenMedia={onOpenMedia} />
        ))}
      </ul>
      {(hidden > 0 || showAll) && batches.length > VISIBLE_BATCHES && (
        <Button variant="ghost" size="sm" onClick={() => setShowAll((v) => !v)} className="self-start">
          {showAll ? "Ver menos" : `Ver ${pluralize(hidden, "lote más", "lotes más")}`}
        </Button>
      )}
    </div>
  );
}
