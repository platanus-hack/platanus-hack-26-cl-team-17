"use client";

import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Film,
  HelpCircle,
  ImageOff,
  Info,
  MessageSquareQuote,
  RefreshCw,
  ScanSearch,
  Siren,
  Star,
  X,
} from "lucide-react";
import type { MediaView, RuntimeMode } from "@/lib/contract";
import type { MediaAnalysis } from "@/lib/domain";
import { api, errorMessage } from "@/lib/client/api";
import { extractVideoFrames, isFrameExtractionError } from "@/lib/client/frames";
import { isAbortError, mapWithConcurrency, putToTarget } from "@/lib/client/upload";
import {
  Badge,
  Button,
  ConfidenceMeter,
  Dialog,
  KeyValue,
  ProgressBar,
  Spinner,
  TimeAgo,
  useToast,
  type KeyValueItem,
} from "@/components/ui";
import { SimulatedNotice } from "@/components/shell";
import { cn } from "@/lib/cn";
import {
  formatBytes,
  formatClock,
  formatCoord,
  formatDateTime,
  formatDistance,
  formatDuration,
  formatHeading,
  formatNumber,
} from "@/lib/format";
import {
  analysisEngineLabel,
  analysisEngineTone,
  cardinalLabel,
  constructionLabel,
  damageLabel,
  elevationLabel,
  fireStageLabel,
  hazardKindIcon,
  hazardKindLabel,
  hazardSeverityLabel,
  hazardSeverityTone,
  incidentTypeLabel,
  mediaKindLabel,
  mediaSourceIcon,
  mediaSourceLabel,
  mediaStatusLabel,
  mediaStatusTone,
  occupantsVisibleLabel,
  personStatusLabel,
  personStatusTone,
  smokeColorLabel,
  smokeVolumeLabel,
  spreadRiskLabel,
  spreadRiskTone,
  structureKindLabel,
  structureSideLabel,
  vehicleKindLabel,
  vehicleStateLabel,
  videoStatusLabel,
} from "@/lib/labels";
import {
  adjacentMedia,
  AT_RISK_PERSON_STATUSES,
  canExtractFramesInBrowser,
  mediaStatusBusy,
  mediaTime,
  posterUrl,
  resolveCitedFrame,
  sortedFrames,
  sortMediaForStrip,
  stageProgress,
} from "./media-utils";
import type { MediaViewerTarget } from "./types";

/** Props de `MediaViewer`. */
export interface MediaViewerProps {
  incidentId: string;
  media: MediaView[];
  target: MediaViewerTarget | null;
  onClose: () => void;
  onChanged: () => void;
  mode: RuntimeMode | null;
  /** Incidente de demostración: sus análisis son datos ficticios. */
  demo?: boolean;
}

/* ═════════════════════ Extracción de fotogramas en el navegador ═════════════════════ */

type ExtractionPhase = "download" | "extract" | "register" | "upload" | "analyze" | "error";

interface ExtractionState {
  mediaId: string;
  phase: ExtractionPhase;
  /** 0..1; null = indeterminado. */
  progress: number | null;
  error: string | null;
}

const phaseLabel: Record<ExtractionPhase, string> = {
  download: "Descargando el video original…",
  extract: "Extrayendo fotogramas en este navegador…",
  register: "Registrando los fotogramas…",
  upload: "Subiendo fotogramas…",
  analyze: "Solicitando el análisis…",
  error: "No se pudieron extraer los fotogramas",
};

function isAbort(err: unknown): boolean {
  return isAbortError(err) || (isFrameExtractionError(err) && err.code === "aborted");
}

/** Descarga el video como blob informando el avance cuando el servidor entrega el largo. */
async function downloadBlob(
  url: string,
  mime: string | null,
  signal: AbortSignal,
  onProgress: (fraction: number | null) => void,
): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch(url, { signal, credentials: "same-origin", cache: "no-store" });
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new Error("No se pudo descargar el video original. Revisa la conexión e inténtalo de nuevo.", { cause: err });
  }
  if (!res.ok) throw new Error(`No se pudo descargar el video original (error ${res.status}).`);
  const type = res.headers.get("content-type") ?? mime ?? "";
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body || total <= 0) {
    onProgress(null);
    const blob = await res.blob();
    onProgress(1);
    return blob;
  }
  const reader = res.body.getReader();
  const chunks: BlobPart[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress(Math.min(1, received / total));
  }
  return new Blob(chunks, { type });
}

/** Extrae fotogramas del video original en el navegador, los sube y pide el análisis del medio. */
function useBrowserFrameExtraction(incidentId: string, onChanged: () => void) {
  const { toast } = useToast();
  const [state, setState] = useState<ExtractionState | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const cancel = () => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setState(null);
  };

  const run = async (m: MediaView) => {
    const videoUrl = m.urls.video;
    if (!videoUrl || controllerRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    const { signal } = controller;
    const mediaId = m.id;
    const update = (phase: ExtractionPhase, progress: number | null) => {
      if (!signal.aborted) setState({ mediaId, phase, progress, error: null });
    };
    try {
      update("download", 0);
      const blob = await downloadBlob(videoUrl, m.mime, signal, (f) =>
        update("download", f === null ? null : stageProgress(0, 0.3, f)),
      );
      update("extract", 0.3);
      const extracted = await extractVideoFrames(blob, {
        signal,
        onProgress: (f) => update("extract", stageProgress(0.3, 0.7, f)),
      });
      update("register", 0.7);
      const { frame_uploads } = await api.incidents.staffFrames(
        incidentId,
        mediaId,
        { frames: extracted.frames.map((f) => ({ idx: f.idx, t_s: f.t_s, width: f.width, height: f.height })) },
        { signal },
      );
      if (frame_uploads.length !== extracted.frames.length) {
        throw new Error("El servidor no entregó un destino por fotograma. Inténtalo de nuevo.");
      }
      update("upload", 0.75);
      let uploaded = 0;
      await mapWithConcurrency(extracted.frames, 3, async (f, i) => {
        await putToTarget(frame_uploads[i], f.blob, { signal });
        uploaded += 1;
        update("upload", stageProgress(0.75, 0.95, uploaded / extracted.frames.length));
      });
      update("analyze", 0.95);
      await api.incidents.analyze(incidentId, { media_id: mediaId }, { signal });
      if (signal.aborted) return;
      setState(null);
      toast({
        title: `Fotogramas de ${m.label} enviados`,
        description: `${extracted.frames.length} fotogramas · el análisis comenzó.`,
        tone: "ok",
      });
      onChanged();
    } catch (err) {
      if (isAbort(err) || signal.aborted) return;
      const message = errorMessage(err);
      setState({ mediaId, phase: "error", progress: null, error: message });
      toast({ title: `No se pudieron extraer los fotogramas de ${m.label}`, description: message, tone: "critical" });
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  };

  const dismissError = () => setState((s) => (s?.phase === "error" ? null : s));

  return { state, run, cancel, dismissError };
}

/* ═══════════════════════════════ Visor ═══════════════════════════════ */

function targetKey(t: MediaViewerTarget | null): string {
  return t ? `${t.mediaId}:${t.frame ?? ""}` : "";
}

/** Visor de un medio a pantalla casi completa: video, fotogramas, análisis de la IA, metadatos y acciones. */
export function MediaViewer({ incidentId, media, target, onClose, onChanged, mode, demo = false }: MediaViewerProps) {
  const baseKey = targetKey(target);
  // Navegación anterior/siguiente local: vale solo mientras el padre mantenga el mismo destino.
  const [nav, setNav] = useState<{ baseKey: string; target: MediaViewerTarget } | null>(null);
  const navTarget = nav && nav.baseKey === baseKey ? nav.target : null;
  const navMedia = navTarget ? media.find((m) => m.id === navTarget.mediaId) : undefined;
  const effective = navMedia ? navTarget : target;
  // Se busca en cada render: el sondeo actualiza estado y análisis en vivo.
  const current = navMedia ?? (target ? media.find((m) => m.id === target.mediaId) : undefined);
  const extraction = useBrowserFrameExtraction(incidentId, onChanged);
  const bodyRef = useRef<HTMLDivElement>(null);

  const ordered = sortMediaForStrip(media);
  const position = current ? ordered.findIndex((m) => m.id === current.id) : -1;
  const prev = current ? adjacentMedia(media, current.id, -1) : null;
  const next = current ? adjacentMedia(media, current.id, 1) : null;

  const go = (m: MediaView | null) => {
    if (m) setNav({ baseKey, target: { mediaId: m.id } });
  };

  const onWindowKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const dialog = bodyRef.current?.closest("dialog");
    const el = e.target instanceof Element ? e.target : null;
    if (!dialog || !el || !dialog.contains(el)) return;
    // No robar las flechas al video, a campos de texto ni a la tira de fotogramas.
    if (el.closest("video, input, textarea, select, [contenteditable='true'], [data-frame-strip], [role='slider']")) return;
    e.preventDefault();
    go(e.key === "ArrowLeft" ? prev : next);
  });

  const open = current !== undefined;
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => onWindowKey(e);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  const SourceIcon = current ? mediaSourceIcon[current.source] : Film;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="full"
      bodyClassName="lg:overflow-hidden"
      title={
        current ? (
          <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono">{current.label}</span>
            <span aria-hidden className="text-faint">
              ·
            </span>
            <SourceIcon aria-hidden className="size-4 text-muted" />
            <span>
              {mediaKindLabel[current.kind]} · {mediaSourceLabel[current.source]}
            </span>
            <Badge tone={mediaStatusTone[current.status]} icon={current.status === "failed" ? CircleAlert : undefined}>
              {mediaStatusLabel[current.status]}
            </Badge>
          </span>
        ) : (
          "Medio"
        )
      }
      description={current ? `Captado ${formatDateTime(mediaTime(current))}` : undefined}
      footer={
        current ? (
          <>
            <span className="mr-auto text-xs text-muted tabular">
              {position >= 0 ? `${position + 1} de ${ordered.length}` : null}
              <span className="ml-2 hidden sm:inline">· Flechas ← → para cambiar de medio</span>
            </span>
            <Button size="sm" variant="ghost" icon={ChevronLeft} disabled={!prev} onClick={() => go(prev)}>
              {prev ? `Anterior (${prev.label})` : "Anterior"}
            </Button>
            <Button size="sm" variant="ghost" iconRight={ChevronRight} disabled={!next} onClick={() => go(next)}>
              {next ? `Siguiente (${next.label})` : "Siguiente"}
            </Button>
            <Button size="sm" onClick={onClose}>
              Cerrar
            </Button>
          </>
        ) : undefined
      }
    >
      <div ref={bodyRef} className="lg:h-full">
        {current && effective && (
          <ViewerBody
            key={`${current.id}:${effective.mediaId === current.id ? (effective.frame ?? "") : ""}`}
            incidentId={incidentId}
            media={current}
            citedFrame={effective.mediaId === current.id ? (effective.frame ?? null) : null}
            mode={mode}
            demo={demo}
            onChanged={onChanged}
            extraction={extraction.state?.mediaId === current.id ? extraction.state : null}
            extractionBusy={extraction.state !== null && extraction.state.phase !== "error"}
            onExtract={() => void extraction.run(current)}
            onCancelExtract={extraction.cancel}
            onDismissExtractError={extraction.dismissError}
          />
        )}
      </div>
    </Dialog>
  );
}

/* ═══════════════════════════════ Cuerpo ═══════════════════════════════ */

interface ViewerBodyProps {
  incidentId: string;
  media: MediaView;
  citedFrame: number | null;
  mode: RuntimeMode | null;
  demo: boolean;
  onChanged: () => void;
  extraction: ExtractionState | null;
  /** Hay una extracción en curso (de este u otro medio). */
  extractionBusy: boolean;
  onExtract: () => void;
  onCancelExtract: () => void;
  onDismissExtractError: () => void;
}

function ViewerBody({
  incidentId,
  media: m,
  citedFrame,
  mode,
  demo,
  onChanged,
  extraction,
  extractionBusy,
  onExtract,
  onCancelExtract,
  onDismissExtractError,
}: ViewerBodyProps) {
  const { toast } = useToast();
  const cited = resolveCitedFrame(m, citedFrame);
  // null = mostrar el video (o el primer fotograma si no hay video).
  const [shown, setShown] = useState<number | null>(cited);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [reanalyzeError, setReanalyzeError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  const frames = sortedFrames(m);
  const videoUrl = m.urls.video;
  const stageFrame =
    shown !== null ? (frames.find((f) => f.idx === shown) ?? null) : videoUrl ? null : (frames[0] ?? null);
  const keyFrames = m.analysis?.key_frames ?? [];
  const captionFor = (idx: number) => keyFrames.find((k) => k.frame === idx)?.caption ?? null;
  // Sin motor informado nunca se supone "IA": solo se marca simulado si la instancia no tiene modelo.
  const engine = m.analysis_engine ?? (m.analysis && (demo || m.source === "demo" || mode?.ai === "simulated") ? "simulated" : null);

  const showFrame = (idx: number) => {
    if (!frames.some((f) => f.idx === idx)) return;
    videoRef.current?.pause();
    setShown(idx);
    stageRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  const reanalyze = async () => {
    setReanalyzing(true);
    setReanalyzeError(null);
    try {
      await api.incidents.analyze(incidentId, { media_id: m.id });
      toast({ title: `Análisis de ${m.label} solicitado`, tone: "ok" });
      onChanged();
    } catch (err) {
      setReanalyzeError(errorMessage(err));
    } finally {
      setReanalyzing(false);
    }
  };

  const reanalyzeDisabled = m.status === "uploading" || m.status === "analyzing" || extraction !== null;

  return (
    <div className="grid gap-4 lg:h-full lg:grid-cols-[minmax(0,1fr)_minmax(340px,440px)]">
      {/* ── Izquierda: video, fotograma en grande y tira de fotogramas ── */}
      <div className="flex min-h-0 min-w-0 flex-col gap-3 lg:overflow-y-auto lg:pr-1">
        <div ref={stageRef} className="flex flex-col gap-2">
          {videoUrl && (
            <video
              ref={videoRef}
              controls
              preload="metadata"
              playsInline
              poster={posterUrl(m) ?? undefined}
              src={videoUrl}
              className={cn("max-h-[60dvh] w-full rounded-md bg-black", stageFrame && "hidden")}
            >
              Tu navegador no puede reproducir este video.
            </video>
          )}
          {stageFrame && (
            <figure className="flex flex-col gap-1.5">
              {/* eslint-disable-next-line @next/next/no-img-element -- URLs de /api/files con redirección firmada */}
              <img
                src={stageFrame.url}
                alt={`${m.label}, fotograma ${stageFrame.idx}${captionFor(stageFrame.idx) ? `: ${captionFor(stageFrame.idx)}` : ""}`}
                className="max-h-[60dvh] w-full rounded-md bg-black object-contain"
              />
              <figcaption className="flex flex-wrap items-center gap-2 text-sm text-muted">
                <span className="font-mono text-text tabular">
                  Fotograma {stageFrame.idx} · {formatNumber(stageFrame.t_s, 1)} s
                </span>
                {stageFrame.idx === cited && (
                  <Badge tone="warning" icon={ScanSearch}>
                    Citado como evidencia
                  </Badge>
                )}
                {captionFor(stageFrame.idx) && <span className="min-w-0">{captionFor(stageFrame.idx)}</span>}
                {videoUrl && (
                  <Button size="sm" variant="ghost" icon={Film} className="ml-auto" onClick={() => setShown(null)}>
                    Ver video
                  </Button>
                )}
              </figcaption>
            </figure>
          )}
          {!videoUrl && !stageFrame && (
            <div className="grid aspect-video w-full place-items-center rounded-md border border-dashed border-line bg-surface-2 text-center text-sm text-muted">
              <span className="flex flex-col items-center gap-2 px-4">
                <ImageOff aria-hidden className="size-8 text-faint" />
                {m.status === "uploading" ? "Las imágenes de este medio aún se están subiendo." : "Aún no hay imágenes de este medio."}
              </span>
            </div>
          )}
          {!videoUrl && m.kind === "video" && <VideoMissingNotice status={m.video_status} />}
        </div>

        {frames.length > 0 && (
          <FrameStrip
            label={m.label}
            frames={frames}
            shown={stageFrame?.idx ?? null}
            cited={cited}
            keyFrameIdx={keyFrames.map((k) => k.frame)}
            onShow={showFrame}
          />
        )}
      </div>

      {/* ── Derecha: estado, acciones, análisis y metadatos ── */}
      <div className="flex min-h-0 min-w-0 flex-col gap-4 lg:overflow-y-auto lg:pr-1">
        <div className="flex flex-col gap-2">
          {m.status === "failed" && m.source !== "demo" && (
            <div role="alert" className="flex items-start gap-2 rounded-md border border-critical/40 bg-critical-soft px-3 py-2 text-sm">
              <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-critical" />
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-critical">Falló el procesamiento de este medio</p>
                <p className="mt-0.5 text-text">{m.error || "Sin detalle del error."}</p>
              </div>
              <Button size="sm" variant="danger" icon={RefreshCw} loading={reanalyzing} onClick={() => void reanalyze()}>
                Reintentar
              </Button>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {m.source === "demo" ? (
              <span className="text-xs text-muted">Medio de demostración: su análisis es fijo y no se reanaliza.</span>
            ) : (
              <Button
                size="sm"
                icon={RefreshCw}
                loading={reanalyzing}
                disabled={reanalyzeDisabled}
                title={reanalyzeDisabled ? "Espera a que termine el proceso en curso" : undefined}
                onClick={() => void reanalyze()}
              >
                Reanalizar este medio
              </Button>
            )}
            {canExtractFramesInBrowser(m) && extraction === null && (
              <Button
                size="sm"
                icon={Film}
                disabled={extractionBusy}
                title={extractionBusy ? "Ya hay una extracción en curso" : undefined}
                onClick={onExtract}
              >
                Extraer fotogramas en este navegador
              </Button>
            )}
          </div>
          {reanalyzeError && (
            <p role="alert" className="text-sm text-critical">
              {reanalyzeError}
            </p>
          )}
          {canExtractFramesInBrowser(m) && extraction === null && (
            <p className="text-xs text-muted">
              Este medio llegó sin fotogramas. Puedes extraerlos aquí desde el video original para que la IA lo analice.
            </p>
          )}
          {extraction && (
            <ExtractionProgress state={extraction} onCancel={onCancelExtract} onRetry={onExtract} onDismiss={onDismissExtractError} />
          )}
        </div>

        <AnalysisSection media={m} engine={engine} mode={mode} demo={demo || m.source === "demo"} onShowFrame={showFrame} />

        <MetadataSection media={m} />
      </div>
    </div>
  );
}

function VideoMissingNotice({ status }: { status: MediaView["video_status"] }) {
  const text =
    status === "failed"
      ? "No se pudo recibir el video original; se analizó con fotogramas."
      : "El video original aún no llega; se analizó con fotogramas.";
  return (
    <p role="note" className="flex items-start gap-2 rounded-md border border-info/40 bg-info-soft px-3 py-2 text-sm text-text">
      <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-info" />
      <span>
        {text} <span className="text-muted">({videoStatusLabel[status]})</span>
      </span>
    </p>
  );
}

function ExtractionProgress({
  state,
  onCancel,
  onRetry,
  onDismiss,
}: {
  state: ExtractionState;
  onCancel: () => void;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  if (state.phase === "error") {
    return (
      <div role="alert" className="flex flex-col gap-2 rounded-md border border-critical/40 bg-critical-soft px-3 py-2 text-sm">
        <p className="flex items-start gap-2">
          <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-critical" />
          <span className="min-w-0">
            <span className="font-semibold text-critical">{phaseLabel.error}.</span> {state.error}
          </span>
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" icon={RefreshCw} onClick={onRetry}>
            Reintentar extracción
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Descartar
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-line bg-surface-2 px-3 py-2" aria-live="polite">
      <div className="flex items-center gap-2 text-sm">
        <Spinner size="xs" label={phaseLabel[state.phase]} />
        <span className="min-w-0 flex-1">{phaseLabel[state.phase]}</span>
        <Button size="sm" variant="ghost" icon={X} onClick={onCancel}>
          Cancelar
        </Button>
      </div>
      <ProgressBar value={state.progress} label="Avance de la extracción de fotogramas" showValue size="sm" />
      <p className="text-xs text-muted">Puedes cerrar el visor: la extracción sigue mientras esta página esté abierta.</p>
    </div>
  );
}

/* ═══════════════════════════ Tira de fotogramas ═══════════════════════════ */

function FrameStrip({
  label,
  frames,
  shown,
  cited,
  keyFrameIdx,
  onShow,
}: {
  label: string;
  frames: MediaView["urls"]["frames"];
  shown: number | null;
  cited: number | null;
  keyFrameIdx: number[];
  onShow: (idx: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  // Al abrir con un fotograma citado, se lleva a la vista.
  useEffect(() => {
    if (cited === null) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-frame-idx="${cited}"]`);
    el?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [cited]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-frame-idx]") ?? []);
    const i = buttons.findIndex((b) => b === document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const nextBtn = buttons[i + (e.key === "ArrowLeft" ? -1 : 1)];
    if (nextBtn) {
      nextBtn.focus();
      onShow(Number(nextBtn.dataset.frameIdx));
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="label-caps text-xs text-muted">
        Fotogramas ({frames.length}){cited !== null ? ` · citado: ${cited}` : ""}
      </h3>
      <div
        ref={listRef}
        role="group"
        aria-label={`Fotogramas de ${label}`}
        data-frame-strip=""
        onKeyDown={onKeyDown}
        className="flex gap-1.5 overflow-x-auto overscroll-x-contain p-0.5 pb-1.5 [scrollbar-width:thin]"
      >
        {frames.map((f) => {
          const isCited = f.idx === cited;
          const isShown = f.idx === shown;
          const isKey = keyFrameIdx.includes(f.idx);
          return (
            <button
              key={f.idx}
              type="button"
              data-frame-idx={f.idx}
              aria-pressed={isShown}
              aria-label={`Fotograma ${f.idx}, segundo ${formatNumber(f.t_s, 1)}${isCited ? ", citado como evidencia" : ""}${isKey ? ", fotograma clave" : ""}`}
              onClick={() => onShow(f.idx)}
              className={cn(
                "relative h-16 w-28 shrink-0 overflow-hidden rounded-md border-2 bg-black",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                isShown ? "border-accent" : isCited ? "border-warning" : "border-transparent hover:border-line-strong",
              )}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- URLs de /api/files con redirección firmada */}
              <img src={f.url} alt="" loading="lazy" decoding="async" draggable={false} className="size-full object-cover" />
              <span
                aria-hidden
                className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-bg/85 px-1 font-mono text-[10px] leading-4 text-text tabular"
              >
                #{f.idx} · {formatNumber(f.t_s, 1)} s
                {isKey && <Star className="ml-auto size-3 fill-current text-warning" />}
              </span>
              {isCited && (
                <span aria-hidden className="absolute top-0 left-0 rounded-br-sm bg-warning px-1 text-[10px] leading-4 font-semibold text-on-solid">
                  CITADO
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ═══════════════════════════════ Análisis ═══════════════════════════════ */

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-t border-line pt-3">
      <div className="flex items-center gap-2">
        <h3 className="label-caps text-xs text-muted">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function FrameRefs({ refs, onShowFrame }: { refs: number[]; onShowFrame: (idx: number) => void }) {
  const unique = [...new Set(refs.filter((r) => Number.isInteger(r) && r >= 0))].sort((a, b) => a - b);
  if (unique.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className="text-xs text-muted">Fotogramas:</span>
      {unique.map((r) => (
        <button
          key={r}
          type="button"
          onClick={() => onShowFrame(r)}
          className="rounded-sm border border-line px-1 font-mono text-[11px] leading-4 text-text tabular hover:border-line-strong focus-visible:outline-2 focus-visible:outline-accent"
          aria-label={`Ver fotograma ${r}`}
        >
          #{r}
        </button>
      ))}
    </span>
  );
}

const yesNo = (v: boolean) => (v ? "Sí" : "No");
const floorText = (n: number) => (n > 0 ? `Piso ${n}` : null);

function TextList({ items, empty }: { items: string[]; empty: string }) {
  const clean = items.map((s) => s.trim()).filter(Boolean);
  if (clean.length === 0) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <ul className="list-disc space-y-0.5 pl-5 text-sm text-text">
      {clean.map((s, i) => (
        <li key={`${i}-${s}`}>{s}</li>
      ))}
    </ul>
  );
}

function AnalysisSection({
  media: m,
  engine,
  mode,
  demo,
  onShowFrame,
}: {
  media: MediaView;
  engine: MediaView["analysis_engine"];
  mode: RuntimeMode | null;
  demo: boolean;
  onShowFrame: (idx: number) => void;
}) {
  const a = m.analysis;

  if (!a) {
    const busy = mediaStatusBusy(m.status);
    return (
      <section className="flex flex-col gap-2 border-t border-line pt-3">
        <h3 className="label-caps text-xs text-muted">Análisis de la IA</h3>
        {busy ? (
          <p className="flex items-center gap-2 text-sm text-text">
            <Spinner size="sm" label="Analizando" />
            {m.status === "uploading" ? "Esperando los fotogramas para analizar…" : "Analizando…"}
          </p>
        ) : (
          <p className="text-sm text-muted">
            {m.status === "failed" ? "Sin análisis: el procesamiento falló." : "Sin análisis aún."}
          </p>
        )}
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-2 border-t border-line pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="label-caps text-xs text-muted">Análisis de la IA</h3>
          {engine && <Badge tone={analysisEngineTone[engine]}>{analysisEngineLabel[engine]}</Badge>}
          <ConfidenceMeter level={a.confidence} />
          {m.analyzed_at && (
            <span className="text-xs text-muted">
              <TimeAgo iso={m.analyzed_at} />
            </span>
          )}
        </div>
        {engine === "simulated" && <SimulatedNotice what="Este análisis" mode={mode} demo={demo} />}
        {!a.usable && (
          <p role="note" className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-sm">
            <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
            <span>
              <span className="font-semibold text-warning">Imágenes no utilizables.</span> {a.unusable_reason}
            </span>
          </p>
        )}
        <p className="text-sm leading-relaxed text-text">{a.summary || "Sin resumen."}</p>
        <p className="text-xs text-muted">Tipo según las imágenes: {incidentTypeLabel[a.incident_type]}</p>
      </section>

      <PeopleSection people={a.people} onShowFrame={onShowFrame} />

      <Section title="Punto de vista">
        <KeyValue
          dense
          columns={2}
          items={[
            { label: "Desde dónde", value: a.viewpoint.position_description },
            { label: "Mirando hacia", value: cardinalLabel[a.viewpoint.facing] },
            {
              label: "Distancia al foco",
              value: a.viewpoint.distance_m > 0 ? formatDistance(a.viewpoint.distance_m) : "No estimada",
            },
            { label: "Altura de la cámara", value: elevationLabel[a.viewpoint.elevation] },
          ]}
        />
      </Section>

      <FireSection fire={a.fire} />

      <Section title="Estructura">
        {a.structure.present ? (
          <KeyValue
            dense
            columns={2}
            items={[
              { label: "Tipo", value: structureKindLabel[a.structure.kind] },
              { label: "Pisos visibles", value: a.structure.floors_visible > 0 ? a.structure.floors_visible : "No determinado" },
              { label: "Construcción", value: constructionLabel[a.structure.construction] },
              { label: "Exposiciones", value: a.structure.exposures },
              { label: "Descripción", value: a.structure.description },
            ]}
          />
        ) : (
          <p className="text-sm text-muted">No se ve una edificación involucrada.</p>
        )}
      </Section>

      <VehiclesSection vehicles={a.vehicles} onShowFrame={onShowFrame} />

      <HazardsSection hazards={a.hazards} onShowFrame={onShowFrame} />

      <Section title="Acceso">
        <KeyValue dense items={[{ label: "Cómo se llega", value: a.access.description }]} />
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <p className="mb-1 text-xs text-muted">Obstáculos</p>
            <TextList items={a.access.obstructions} empty="No se informan." />
          </div>
          <div>
            <p className="mb-1 text-xs text-muted">Fuentes de agua</p>
            <TextList items={a.access.water_sources} empty="No se ven." />
          </div>
        </div>
      </Section>

      {a.key_frames.length > 0 && (
        <Section title="Fotogramas clave">
          <ul className="space-y-1.5">
            {a.key_frames.map((k, i) => (
              <li key={`${k.frame}-${i}`} className="flex items-start gap-2 text-sm">
                <button
                  type="button"
                  onClick={() => onShowFrame(k.frame)}
                  className="shrink-0 rounded-sm border border-line px-1 font-mono text-[11px] leading-5 text-text tabular hover:border-line-strong focus-visible:outline-2 focus-visible:outline-accent"
                  aria-label={`Ver fotograma ${k.frame}`}
                >
                  #{k.frame}
                </button>
                <span className="min-w-0 text-text">{k.caption}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Texto visible">
        {a.visible_text.filter((t) => t.trim()).length > 0 ? (
          <ul className="flex flex-wrap gap-1.5">
            {a.visible_text
              .filter((t) => t.trim())
              .map((t, i) => (
                <li key={`${i}-${t}`} className="rounded-sm border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-text">
                  {t}
                </li>
              ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">No se lee texto útil.</p>
        )}
      </Section>

      <Section title="Incertidumbres" aside={<HelpCircle aria-hidden className="size-3.5 text-muted" />}>
        <TextList items={a.uncertainties} empty="La IA no informó incertidumbres." />
      </Section>
    </div>
  );
}

function PeopleSection({
  people,
  onShowFrame,
}: {
  people: MediaAnalysis["people"];
  onShowFrame: (idx: number) => void;
}) {
  const atRisk = people.some((p) => AT_RISK_PERSON_STATUSES.has(p.status));
  return (
    <Section
      title="Personas"
      aside={
        atRisk ? (
          <Badge tone="critical" variant="solid" icon={Siren} pulse>
            Personas en riesgo
          </Badge>
        ) : undefined
      }
    >
      {people.length === 0 ? (
        <p className="text-sm text-muted">
          No se observan personas en estas imágenes. <strong className="font-semibold text-text">Esto no descarta víctimas.</strong>
        </p>
      ) : (
        <ul className="space-y-2">
          {people.map((p, i) => {
            const risk = AT_RISK_PERSON_STATUSES.has(p.status);
            return (
              <li
                key={`${p.status}-${i}`}
                className={cn(
                  "flex flex-col gap-1 rounded-md border px-2.5 py-2",
                  risk ? "border-critical/50 bg-critical-soft" : "border-line bg-surface-2",
                )}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={personStatusTone[p.status]} icon={risk ? Siren : undefined} size="md">
                    {personStatusLabel[p.status]}
                  </Badge>
                  <span className="text-sm font-semibold text-text tabular">
                    {p.count > 0 ? `${p.count} ${p.count === 1 ? "persona" : "personas"}` : "Cantidad no determinada"}
                  </span>
                  <ConfidenceMeter level={p.confidence} size="sm" className="ml-auto" />
                </div>
                {(p.location || floorText(p.floor)) && (
                  <p className="text-sm text-text">{[floorText(p.floor), p.location].filter(Boolean).join(" · ")}</p>
                )}
                {p.description && <p className="text-sm text-muted">{p.description}</p>}
                <FrameRefs refs={p.frame_refs} onShowFrame={onShowFrame} />
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function FireSection({ fire }: { fire: MediaAnalysis["fire"] }) {
  const items: KeyValueItem[] = [
    { label: "Fuego", value: fire.present ? "Presente" : "No se ve" },
    { label: "Etapa", value: fireStageLabel[fire.stage] },
    { label: "Llamas visibles", value: yesNo(fire.flames_visible) },
    {
      label: "Riesgo de propagación",
      value: <Badge tone={spreadRiskTone[fire.spread_risk]}>{spreadRiskLabel[fire.spread_risk]}</Badge>,
    },
    {
      label: "Humo",
      value: fire.smoke.present
        ? `${smokeColorLabel[fire.smoke.color]} · ${smokeVolumeLabel[fire.smoke.volume]}`
        : "No se ve",
      hint: fire.smoke.description || undefined,
    },
  ];
  return (
    <Section title="Fuego y humo">
      <KeyValue dense columns={2} items={items} />
      {fire.locations.length > 0 && (
        <ul className="space-y-1 text-sm">
          {fire.locations.map((l, i) => (
            <li key={i} className="flex flex-wrap gap-x-2">
              <span className="font-semibold text-text">
                {[floorText(l.floor), structureSideLabel[l.side]].filter(Boolean).join(" · ")}
              </span>
              {l.description && <span className="text-muted">{l.description}</span>}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function VehiclesSection({
  vehicles,
  onShowFrame,
}: {
  vehicles: MediaAnalysis["vehicles"];
  onShowFrame: (idx: number) => void;
}) {
  if (vehicles.length === 0) {
    return (
      <Section title="Vehículos">
        <p className="text-sm text-muted">No se ven vehículos involucrados.</p>
      </Section>
    );
  }
  return (
    <Section title="Vehículos">
      <ul className="space-y-2">
        {vehicles.map((v, i) => (
          <li
            key={i}
            className={cn(
              "flex flex-col gap-1 rounded-md border px-2.5 py-2",
              v.entrapment_suspected ? "border-critical/50 bg-critical-soft" : "border-line bg-surface-2",
            )}
          >
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-semibold text-text">{vehicleKindLabel[v.kind]}</span>
              <span className="text-muted">
                {vehicleStateLabel[v.state]} · Daño {damageLabel[v.damage].toLowerCase()}
              </span>
              {v.entrapment_suspected && (
                <Badge tone="critical" icon={Siren}>
                  Posible atrapamiento
                </Badge>
              )}
              {v.leaking_fluids && <Badge tone="warning">Derrame de fluidos</Badge>}
            </div>
            <p className="text-xs text-muted">Ocupantes visibles: {occupantsVisibleLabel[v.occupants_visible]}</p>
            {v.position && <p className="text-sm text-text">{v.position}</p>}
            {v.description && <p className="text-sm text-muted">{v.description}</p>}
            <FrameRefs refs={v.frame_refs} onShowFrame={onShowFrame} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

function HazardsSection({
  hazards,
  onShowFrame,
}: {
  hazards: MediaAnalysis["hazards"];
  onShowFrame: (idx: number) => void;
}) {
  return (
    <Section title="Peligros">
      {hazards.length === 0 ? (
        <p className="text-sm text-muted">No se identifican peligros en estas imágenes.</p>
      ) : (
        <ul className="space-y-2">
          {hazards.map((h, i) => {
            const Icon = hazardKindIcon[h.kind];
            return (
              <li key={`${h.kind}-${i}`} className="flex items-start gap-2 text-sm">
                <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", h.severity === "high" ? "text-critical" : "text-warning")} />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-text">{hazardKindLabel[h.kind]}</span>
                    <Badge tone={hazardSeverityTone[h.severity]}>{hazardSeverityLabel[h.severity]}</Badge>
                  </div>
                  {h.description && <p className="text-muted">{h.description}</p>}
                  <FrameRefs refs={h.frame_refs} onShowFrame={onShowFrame} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

/* ═══════════════════════════════ Metadatos ═══════════════════════════════ */

function MetadataSection({ media: m }: { media: MediaView }) {
  const hasGps = m.lat !== null && m.lng !== null;
  const items: KeyValueItem[] = [
    { label: "Fuente", value: mediaSourceLabel[m.source] },
    { label: "Tipo", value: mediaKindLabel[m.kind] },
    { label: "Captado", value: m.captured_at ? formatDateTime(m.captured_at, { seconds: true }) : "No informado", mono: true },
    { label: "Recibido", value: formatClock(m.created_at), mono: true },
    { label: "Duración", value: m.duration_s !== null ? formatDuration(m.duration_s) : null },
    {
      label: "GPS",
      value: hasGps ? formatCoord(m.lat as number, m.lng as number) : "Sin ubicación",
      mono: hasGps,
      hint: hasGps && m.accuracy_m !== null ? `Precisión ±${formatNumber(m.accuracy_m)} m` : undefined,
    },
    { label: "Rumbo de la cámara", value: formatHeading(m.heading_deg ?? -1) },
    { label: "Video original", value: videoStatusLabel[m.video_status] },
    { label: "Tamaño", value: m.size_bytes !== null ? formatBytes(m.size_bytes) : null },
    { label: "Fotogramas", value: m.urls.frames.length },
  ];
  const note = m.reporter_note.trim();
  return (
    <Section title="Metadatos">
      <KeyValue dense columns={2} items={items} />
      {note && (
        <figure className="flex flex-col gap-1 rounded-md border border-warning/40 bg-warning-soft px-3 py-2">
          <figcaption className="label-caps flex items-center gap-1.5 text-xs text-warning">
            <MessageSquareQuote aria-hidden className="size-3.5" />
            Nota del vecino — sin verificar
          </figcaption>
          <blockquote className="text-sm whitespace-pre-line text-text">{note}</blockquote>
        </figure>
      )}
    </Section>
  );
}
