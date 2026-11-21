"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, CircleAlert, FlaskConical, Mic, RotateCcw, Trash2 } from "lucide-react";
import { Badge, Button, Spinner } from "@/components/ui";
import { cn } from "@/lib/cn";
import type { CommEntry } from "@/lib/domain";
import { formatClock, formatDateTime } from "@/lib/format";
import { commAudioUrl, commSourceShort, type EntryTag, type PendingComm } from "./comms-model";

/** Solicitud de llevar una entrada a la vista; `nonce` permite repetir la misma. */
export interface LogFocus {
  seq: number | null;
  nonce: number;
}

export interface CommsLogProps {
  entries: CommEntry[];
  pending: PendingComm[];
  tags: ReadonlyMap<number, EntryTag[]>;
  focus: LogFocus;
  onRetry: (localId: string) => void;
  onDiscard: (localId: string) => void;
  /** Se muestra cuando no hay entradas ni pendientes. */
  empty: ReactNode;
  className?: string;
}

const BOTTOM_SLACK_PX = 48;
const HIGHLIGHT_MS = 2600;

function distanceToBottom(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

function EntryHeader({
  seqLabel,
  at,
  speaker,
  channel,
  source,
}: {
  seqLabel: string;
  at: string;
  speaker: string;
  channel: string;
  source: CommEntry["source"];
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
      <span className="font-mono font-semibold text-accent tabular">{seqLabel}</span>
      {/* La hora local depende de la zona del navegador: se corrige al hidratar. */}
      <time dateTime={at} title={formatDateTime(at, { seconds: true })} suppressHydrationWarning className="font-mono text-muted tabular">
        {formatClock(at)}
      </time>
      <span className="min-w-0 truncate font-semibold text-text">{speaker.trim() || "Sin emisor"}</span>
      {channel.trim() && <span className="text-muted">· {channel}</span>}
      <span className="ml-auto">
        {source === "simulated" ? (
          <Badge tone="warning" icon={FlaskConical} title="Entrada de simulacro: no es tráfico radial real">
            {commSourceShort.simulated}
          </Badge>
        ) : source === "dictation" ? (
          <Badge tone="info" icon={Mic} title="Transcrita por dictado: puede tener errores">
            {commSourceShort.dictation}
          </Badge>
        ) : (
          <Badge tone="neutral">{commSourceShort[source] ?? source}</Badge>
        )}
      </span>
    </div>
  );
}

/** Bitácora cronológica: sigue lo último salvo que el usuario haya subido; resalta la entrada pedida. */
export function CommsLog({ entries, pending, tags, focus, onRetry, onDiscard, empty, className }: CommsLogProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef(new Map<number, HTMLLIElement>());
  const total = entries.length + pending.length;
  const lastKey = pending.length > 0 ? pending[pending.length - 1].localId : (entries[entries.length - 1]?.id ?? "");

  // null = siguiendo el final; número = cuántas entradas había cuando el usuario subió.
  const [leftAtCount, setLeftAtCount] = useState<number | null>(null);
  const following = leftAtCount === null;
  const unseen = leftAtCount === null ? 0 : Math.max(0, total - leftAtCount);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = distanceToBottom(el) < BOTTOM_SLACK_PX;
    if (atBottom && leftAtCount !== null) setLeftAtCount(null);
    else if (!atBottom && leftAtCount === null) setLeftAtCount(total);
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && following) el.scrollTop = el.scrollHeight;
  }, [following, total, lastKey]);

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setLeftAtCount(null);
  };

  // Resaltado de la entrada pedida (clic en una evidencia "C12").
  const [flash, setFlash] = useState<{ seq: number; nonce: number } | null>(null);
  const targetPresent = focus.seq !== null && entries.some((e) => e.seq === focus.seq);
  useEffect(() => {
    if (focus.seq === null || !targetPresent) return;
    const seq = focus.seq;
    const nonce = focus.nonce;
    const el = itemRefs.current.get(seq);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    const start = setTimeout(() => setFlash({ seq, nonce }), 0);
    const end = setTimeout(() => setFlash((f) => (f && f.nonce === nonce ? null : f)), HIGHLIGHT_MS);
    return () => {
      clearTimeout(start);
      clearTimeout(end);
    };
  }, [focus.seq, focus.nonce, targetPresent]);

  const setItemRef = useCallback(
    (seq: number) => (node: HTMLLIElement | null) => {
      if (node) itemRefs.current.set(seq, node);
      else itemRefs.current.delete(seq);
    },
    [],
  );

  return (
    <div className={cn("relative flex min-h-0 flex-col", className)}>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto"
        role="log"
        aria-label="Bitácora de radio"
        aria-live="polite"
        aria-relevant="additions"
      >
        {total === 0 ? (
          empty
        ) : (
          <ol className="flex flex-col divide-y divide-line">
            {entries.map((e) => {
              const entryTags = tags.get(e.seq) ?? [];
              const highlighted = flash !== null && flash.seq === e.seq;
              const critical = entryTags.some((t) => t.tone === "critical");
              return (
                <li
                  key={e.id}
                  ref={setItemRef(e.seq)}
                  data-seq={e.seq}
                  aria-current={highlighted ? "true" : undefined}
                  className={cn(
                    "scroll-my-2 border-l-2 px-3 py-2 transition-colors duration-500",
                    critical ? "border-l-critical" : "border-l-transparent",
                    highlighted && "bg-accent-soft ring-1 ring-accent/60 ring-inset",
                  )}
                >
                  <EntryHeader
                    seqLabel={`C${e.seq}`}
                    at={e.at}
                    speaker={e.speaker}
                    channel={e.channel}
                    source={e.source}
                  />
                  <p className="mt-0.5 text-sm leading-snug break-words whitespace-pre-wrap text-text">{e.text}</p>
                  {e.audio_path && (
                    <audio
                      controls
                      preload="none"
                      src={commAudioUrl(e.audio_path)}
                      aria-label={`Grabación de C${e.seq}`}
                      className="mt-1 h-8 w-full max-w-sm"
                    />
                  )}
                  {entryTags.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {entryTags.map((t) => (
                        <Badge key={t.key} tone={t.tone} variant={t.kind === "mayday" ? "solid" : "soft"} dot>
                          {t.label}
                        </Badge>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
            {pending.map((p) => (
              <li
                key={p.localId}
                className={cn(
                  "border-l-2 px-3 py-2",
                  p.status === "failed" ? "border-l-critical bg-critical-soft" : "border-l-transparent opacity-75",
                )}
              >
                <EntryHeader
                  seqLabel="C—"
                  at={p.input.at ?? p.createdAt}
                  speaker={p.input.speaker}
                  channel={p.input.channel}
                  source={p.input.source}
                />
                <p className="mt-0.5 text-sm leading-snug break-words whitespace-pre-wrap text-text">{p.input.text}</p>
                {p.status === "sending" ? (
                  <p className="mt-1 flex items-center gap-1.5 text-xs text-muted">
                    <Spinner size="xs" label="" />
                    {p.input.audio ? "Subiendo grabación…" : "Enviando…"}
                  </p>
                ) : (
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <p className="flex min-w-0 items-start gap-1.5 text-xs text-critical" role="alert">
                      <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                      <span>No se guardó: {p.error ?? "error desconocido"}</span>
                    </p>
                    <span className="ml-auto flex gap-1">
                      <Button size="sm" variant="secondary" icon={RotateCcw} onClick={() => onRetry(p.localId)}>
                        Reintentar
                      </Button>
                      <Button size="sm" variant="ghost" icon={Trash2} onClick={() => onDiscard(p.localId)}>
                        Descartar
                      </Button>
                    </span>
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>

      {!following && unseen > 0 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
          <Button size="sm" variant="primary" icon={ArrowDown} onClick={jumpToLatest} className="pointer-events-auto">
            {unseen === 1 ? "1 nueva" : `${unseen} nuevas`}
          </Button>
        </div>
      )}
    </div>
  );
}
