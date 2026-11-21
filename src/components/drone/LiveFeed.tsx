"use client";

import { useEffect, useRef, useState } from "react";
import { Eye, Maximize2, Minimize2, Sparkles, VideoOff } from "lucide-react";
import { Badge, IconButton, Spinner, useNow } from "@/components/ui";
import { toneText, type Tone } from "@/components/ui/tone";
import { api } from "@/lib/client/api";
import type { LiveInsightView, LiveInsightsResponse } from "@/lib/contract";
import type { TimelineSeverity } from "@/lib/domain";
import { formatClock } from "@/lib/format";
import { cn } from "@/lib/cn";

/** Pausa entre consultas de cuadro (la respuesta 204 sin cuadro nuevo es barata). */
const FRAME_POLL_MS = 250;
const FRAME_RETRY_MS = 2000;
const INSIGHTS_POLL_MS = 3000;
/** Sin cuadro nuevo por más que esto, el video se marca como detenido. */
const STALE_MS = 4000;

const SEVERITY_TONE: Record<TimelineSeverity, Tone> = {
  info: "neutral",
  notice: "info",
  warning: "warning",
  critical: "critical",
};

type FeedState = { kind: "waiting" } | { kind: "frame"; url: string; receivedAt: number; at: string } | { kind: "error" };

/** Consulta el último cuadro en vivo; nunca hay dos consultas a la vez y se pausa con la pestaña oculta. */
function useLiveFrame(missionId: string, enabled: boolean): FeedState {
  const [feed, setFeed] = useState<FeedState>({ kind: "waiting" });

  useEffect(() => {
    if (!enabled) return;
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let seq: string | null = null;
    let url: string | null = null;
    let running = false;

    const schedule = (ms: number) => {
      if (ctl.signal.aborted) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(poll, ms);
    };

    async function poll() {
      timer = null;
      if (ctl.signal.aborted || running) return;
      if (document.hidden) return;
      running = true;
      let next = FRAME_POLL_MS;
      try {
        const q = seq ? `?after=${encodeURIComponent(seq)}` : "";
        const res = await fetch(`/api/drone/${encodeURIComponent(missionId)}/live${q}`, {
          cache: "no-store",
          credentials: "same-origin",
          signal: ctl.signal,
        });
        if (res.status === 200) {
          const blob = await res.blob();
          if (ctl.signal.aborted) return;
          seq = res.headers.get("x-live-seq");
          const prev = url;
          url = URL.createObjectURL(blob);
          setFeed({ kind: "frame", url, receivedAt: Date.now(), at: res.headers.get("x-live-at") ?? new Date().toISOString() });
          // El cuadro anterior se libera cuando el nuevo ya está pintado.
          if (prev) setTimeout(() => URL.revokeObjectURL(prev), 1000);
        } else if (res.status === 404) {
          next = 1000;
        } else if (res.status !== 204) {
          next = FRAME_RETRY_MS;
          if (url === null) setFeed({ kind: "error" });
        }
      } catch {
        if (ctl.signal.aborted) return;
        next = FRAME_RETRY_MS;
      } finally {
        running = false;
      }
      schedule(next);
    }

    const onVisibility = () => {
      if (!document.hidden && !running && timer === null) schedule(0);
    };
    document.addEventListener("visibilitychange", onVisibility);
    schedule(0);
    return () => {
      ctl.abort();
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      if (url) URL.revokeObjectURL(url);
    };
  }, [missionId, enabled]);

  return feed;
}

function useLiveInsights(missionId: string, enabled: boolean): LiveInsightsResponse | null {
  const [data, setData] = useState<LiveInsightsResponse | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      if (!document.hidden) {
        try {
          setData(await api.drone.liveInsights(missionId, { signal: ctl.signal }));
        } catch {
          // Red caída o servidor reiniciando: se reintenta en la próxima vuelta.
        }
      }
      if (!ctl.signal.aborted) timer = setTimeout(poll, INSIGHTS_POLL_MS);
    };
    void poll();
    return () => {
      ctl.abort();
      if (timer !== null) clearTimeout(timer);
    };
  }, [missionId, enabled]);
  return data;
}

function InsightRow({ insight, latest }: { insight: LiveInsightView; latest: boolean }) {
  const tone = insight.engine === "error" ? "neutral" : SEVERITY_TONE[insight.severity];
  return (
    <li className={cn("flex flex-col gap-1", !latest && "text-sm")}>
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 font-mono text-xs text-faint tabular">{formatClock(insight.at, { seconds: true })}</span>
        <p
          className={cn(
            "min-w-0 flex-1 leading-snug",
            latest ? "font-display text-base font-semibold" : "text-muted",
            latest && tone !== "neutral" ? toneText[tone] : latest && "text-text",
          )}
        >
          {insight.summary}
        </p>
        {insight.engine === "simulated" && (
          <Badge tone="warning" size="sm" variant="solid">
            Simulado
          </Badge>
        )}
      </div>
      {latest && insight.observations.length > 0 && (
        <ul className="ml-14 list-disc space-y-0.5 pl-4 text-sm text-text/80">
          {insight.observations.map((o, i) => (
            <li key={i}>{o}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

export interface LiveFeedProps {
  missionId: string;
  label: string;
  /** false cuando la misión terminó: deja de consultar. */
  active: boolean;
  className?: string;
}

/** Video en vivo del dron con las observaciones de la IA cada ~15 s. */
export function LiveFeed({ missionId, label, active, className }: LiveFeedProps) {
  const now = useNow(1000);
  const feed = useLiveFrame(missionId, active);
  const insights = useLiveInsights(missionId, active);
  const boxRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === boxRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void boxRef.current?.requestFullscreen?.().catch(() => undefined);
  };

  const age = feed.kind === "frame" && now !== null ? Math.max(0, now - feed.receivedAt) : null;
  const stale = age !== null && age > STALE_MS;
  const list = insights?.insights ?? [];
  const [latest, ...older] = list;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div ref={boxRef} className="relative aspect-video w-full overflow-hidden rounded-md border border-line bg-black">
        {feed.kind === "frame" ? (
          // eslint-disable-next-line @next/next/no-img-element -- cuadro local (blob:) que cambia varias veces por segundo
          <img
            src={feed.url}
            alt={`Video en vivo del dron ${label}`}
            className={cn("size-full object-contain", stale && "opacity-60 grayscale")}
          />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-sm text-white/75">
            {feed.kind === "error" ? (
              <>
                <VideoOff aria-hidden="true" className="size-7" />
                No pudimos cargar el video. Reintentando…
              </>
            ) : (
              <>
                <Spinner size="md" label="Esperando video" />
                Esperando video del dron. Aparece apenas el sensor toque «Iniciar envío».
              </>
            )}
          </div>
        )}

        <div className="pointer-events-none absolute inset-x-2 top-2 flex items-center justify-between gap-2">
          {feed.kind === "frame" && (
            <span
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-xs font-semibold text-white backdrop-blur-sm",
                stale ? "bg-black/60" : "bg-critical/85",
              )}
            >
              <span className={cn("size-2 rounded-full bg-white", !stale && "animate-pulse")} aria-hidden="true" />
              {stale ? `SEÑAL DETENIDA · hace ${Math.round((age ?? 0) / 1000)} s` : "EN VIVO"}
            </span>
          )}
          <span className="rounded-md bg-black/60 px-2 py-1 font-mono text-xs font-semibold text-white backdrop-blur-sm">
            Dron {label}
          </span>
        </div>

        {feed.kind === "frame" && (
          <div className="absolute right-2 bottom-2">
            <IconButton
              icon={fullscreen ? Minimize2 : Maximize2}
              label={fullscreen ? "Salir de pantalla completa" : "Ver en pantalla completa"}
              size="sm"
              variant="secondary"
              onClick={toggleFullscreen}
            />
          </div>
        )}

        {fullscreen && latest && (
          <p className="absolute inset-x-0 bottom-0 bg-black/70 px-4 py-3 pr-14 font-display text-lg leading-snug font-semibold text-white">
            {latest.summary}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2 rounded-md border border-line bg-surface-2 p-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="label-caps flex items-center gap-1.5 text-xs text-muted">
            <Sparkles aria-hidden="true" className="size-3.5" />
            Observador IA · cada {insights?.every_s ?? 15} s
          </span>
          {insights?.analyzing && (
            <span className="flex items-center gap-1.5 text-xs text-muted">
              <Spinner size="xs" label="Analizando" />
              mirando el video…
            </span>
          )}
        </div>
        {latest ? (
          <ul className="flex flex-col gap-2">
            <InsightRow insight={latest} latest />
            {older.slice(0, 3).map((i) => (
              <InsightRow key={i.id} insight={i} latest={false} />
            ))}
          </ul>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Eye aria-hidden="true" className="size-4 shrink-0" />
            {feed.kind === "frame"
              ? "La primera observación llega en unos segundos."
              : "Cuando llegue video, la IA dejará aquí una observación corta cada 15 s."}
          </p>
        )}
      </div>
    </div>
  );
}
