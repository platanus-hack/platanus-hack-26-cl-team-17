"use client";

/**
 * Panel de la reconstrucción 3D (Gaussian Splatting) de un incidente: explica qué
 * es, la lanza, muestra el avance por etapas y, cuando está lista, el visor con sus
 * insignias de honestidad (alineación, escala, GPU, cuadros, fecha).
 * La vista sintética (backend "demo") se rotula SIEMPRE como tal.
 */
import { useState } from "react";
import {
  AlertTriangle,
  Box,
  Check,
  Cpu,
  FlaskConical,
  Info,
  RefreshCw,
  Ruler,
  ScanEye,
  ShieldAlert,
} from "lucide-react";
import type { MediaView, RuntimeMode } from "@/lib/contract";
import type { Incident, Reconstruction } from "@/lib/domain";
import { api, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/cn";
import { formatClock, formatDate, formatDateTime, formatDuration, formatNumber, pluralize } from "@/lib/format";
import { hasOriginalVideo, isReconstructionEligible, realFrames } from "@/lib/splat/manifest";
import {
  ACTIVE_STAGES,
  alignmentHint,
  alignmentLabel,
  displayProgress,
  geometricConfidence,
  isReconstructionActive,
  isReconstructionStale,
  reconstructionStatusLabel,
  stageRank,
} from "@/lib/splat/status";
import { Badge, Button, ConfidenceMeter, Elapsed, Panel, ProgressBar, Spinner, useNow } from "@/components/ui";
import type { Tone } from "@/components/ui";
import { SimulatedNotice } from "@/components/shell";
import { SplatViewer } from "./SplatViewer";

export interface ReconstructionPanelProps {
  incident: Incident;
  media: MediaView[];
  mode: RuntimeMode;
  /** Se llama tras lanzar una reconstrucción para que el contenedor refresque el snapshot. */
  onChanged: () => void;
  className?: string;
}

export const SYNTHETIC_LABEL = "Vista sintética · generada desde el esquema de la IA, no desde los videos";

const fileUrl = (path: string) => `/api/files/${path.split("/").map(encodeURIComponent).join("/")}`;

const alignmentTone: Record<Reconstruction["alignment"], Tone> = {
  gps: "ok",
  approximate: "info",
  none: "warning",
};

function StatusBadge({ rec, stale }: { rec: Reconstruction | null; stale: boolean }) {
  if (!rec) return null;
  if (rec.status === "ready") {
    return rec.backend === "demo" ? (
      <Badge tone="warning" icon={FlaskConical}>
        Sintética
      </Badge>
    ) : (
      <Badge tone="ok" dot>
        Lista
      </Badge>
    );
  }
  if (rec.status === "failed") {
    return (
      <Badge tone="critical" icon={AlertTriangle}>
        Falló
      </Badge>
    );
  }
  if (stale) return <Badge tone="warning">Sin noticias</Badge>;
  return (
    <Badge tone="accent" pulse>
      {reconstructionStatusLabel[rec.status]} · {Math.round(displayProgress(rec) * 100)} %
    </Badge>
  );
}

function InputsSummary({ media }: { media: MediaView[] }) {
  const eligible = media.filter(isReconstructionEligible);
  if (eligible.length === 0) {
    return (
      <p className="flex items-start gap-2 text-sm text-muted">
        <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-faint" />
        Aún no hay videos ni cuadros reales de este incidente (los de demostración no sirven para reconstruir).
      </p>
    );
  }
  const videos = eligible.filter(hasOriginalVideo).length;
  const drone = eligible.filter((m) => m.source === "drone" && !hasOriginalVideo(m));
  const droneFrames = drone.reduce((n, m) => n + realFrames(m).length, 0);
  const framesOnly = eligible.filter((m) => m.source !== "drone" && !hasOriginalVideo(m)).length;
  const hasDrone = eligible.some((m) => m.source === "drone");
  const parts: string[] = [];
  if (videos > 0) parts.push(pluralize(videos, "video original", "videos originales"));
  if (drone.length > 0) parts.push(`${pluralize(drone.length, "lote", "lotes")} del dron (${pluralize(droneFrames, "cuadro")})`);
  if (framesOnly > 0) parts.push(pluralize(framesOnly, "medio con cuadros", "medios con cuadros"));
  return (
    <p className="flex items-start gap-2 text-sm text-text">
      <ScanEye aria-hidden className="mt-0.5 size-4 shrink-0 text-info" />
      <span>
        Disponible para reconstruir: {parts.join(", ")}.
        {!hasDrone && <span className="text-muted"> Sin dron, la escala y el norte quedan aproximados.</span>}
      </span>
    </p>
  );
}

function Intro({
  incident,
  media,
  gpu,
  busy,
  canStart,
  onStart,
}: {
  incident: Incident;
  media: MediaView[];
  gpu: boolean;
  busy: boolean;
  canStart: boolean;
  onStart: () => void;
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm leading-relaxed text-text">
        Junta los videos y cuadros del incidente —de vecinos y del dron— y arma un modelo 3D real del lugar con{" "}
        <strong>Gaussian Splatting</strong>, entrenado en una GPU en la nube. Sirve para recorrer la escena desde
        cualquier ángulo antes de llegar.
      </p>
      <ul className="space-y-1.5 text-sm text-muted">
        <li className="flex gap-2">
          <span aria-hidden className="text-faint">•</span>
          Necesita varios ángulos: videos tomados desde distintos puntos, idealmente caminando alrededor.
        </li>
        <li className="flex gap-2">
          <span aria-hidden className="text-faint">•</span>
          El dron es ideal: su órbita da cuadros con posición GPS y la reconstrucción queda alineada y a escala.
        </li>
        <li className="flex gap-2">
          <span aria-hidden className="text-faint">•</span>
          Tarda varios minutos; puedes seguir trabajando mientras tanto.
        </li>
      </ul>
      {gpu && <InputsSummary media={media} />}
      {!gpu && (
        <div
          role="note"
          className="flex items-start gap-2.5 rounded-md border border-warning/40 bg-warning-soft px-3 py-2.5 text-sm text-text"
        >
          <FlaskConical aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
          <span>
            Esta instancia no tiene GPU configurada.{" "}
            {incident.scene ? (
              <>
                Se generará una <strong>vista sintética</strong> a partir del esquema de la escena de la IA: no viene
                de los videos y no sirve para medir.
              </>
            ) : (
              <>La IA todavía no arma el esquema de la escena; cuando aparezca podrás generar una vista sintética.</>
            )}
          </span>
        </div>
      )}
      <Button variant="primary" icon={Box} onClick={onStart} loading={busy} disabled={!canStart}>
        Reconstruir en 3D
      </Button>
    </div>
  );
}

function Progress({
  rec,
  stale,
  busy,
  canStart,
  onStart,
}: {
  rec: Reconstruction;
  stale: boolean;
  busy: boolean;
  canStart: boolean;
  onStart: () => void;
}) {
  const current = stageRank(rec.status);
  return (
    <div className="space-y-3">
      <ol className="grid grid-cols-5 gap-1" aria-label="Etapas de la reconstrucción">
        {ACTIVE_STAGES.map((stage) => {
          const rank = stageRank(stage);
          const done = rank < current;
          const now = rank === current;
          return (
            <li
              key={stage}
              aria-current={now ? "step" : undefined}
              className={cn(
                "flex min-w-0 flex-col gap-1 rounded-md border px-1.5 py-1.5 text-center",
                done && "border-ok/40 bg-ok-soft text-ok",
                now && "border-accent/50 bg-surface-2 text-text",
                !done && !now && "border-line text-faint",
              )}
            >
              <span className="flex h-4 items-center justify-center">
                {done ? (
                  <Check aria-hidden className="size-4" />
                ) : now && !stale ? (
                  <Spinner size="xs" label={reconstructionStatusLabel[stage]} />
                ) : (
                  <span aria-hidden className="size-1.5 rounded-full bg-current" />
                )}
              </span>
              <span className="truncate text-[11px] leading-tight sm:text-xs">{reconstructionStatusLabel[stage]}</span>
              {done && <span className="sr-only">(completada)</span>}
            </li>
          );
        })}
      </ol>
      <ProgressBar value={displayProgress(rec)} showValue label="Avance de la reconstrucción" tone={stale ? "warning" : "accent"} />
      <p className="text-sm text-text" aria-live="polite">
        {rec.message}
      </p>
      <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
        <span>
          Solicitada hace <Elapsed since={rec.requested_at} className="tabular" />
        </span>
        {rec.frame_count > 0 && (
          <span>
            ≈ {pluralize(rec.frame_count, "cuadro")} de {pluralize(rec.media_ids.length, "medio")}
          </span>
        )}
        {rec.gpu && <span>GPU {rec.gpu}</span>}
        {rec.iterations !== null && <span>{formatNumber(rec.iterations)} iteraciones</span>}
      </p>
      {stale && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2.5 rounded-md border border-warning/40 bg-warning-soft px-3 py-2.5 text-sm text-text"
        >
          <AlertTriangle aria-hidden className="size-4 shrink-0 text-warning" />
          <span className="min-w-0 flex-1">No hay noticias del job hace mucho rato: puede haberse detenido.</span>
          <Button size="sm" icon={RefreshCw} onClick={onStart} loading={busy} disabled={!canStart}>
            Lanzar de nuevo
          </Button>
        </div>
      )}
    </div>
  );
}

function Failed({
  rec,
  busy,
  canStart,
  onStart,
}: {
  rec: Reconstruction;
  busy: boolean;
  canStart: boolean;
  onStart: () => void;
}) {
  return (
    <div role="alert" className="space-y-3 rounded-md border border-critical/40 bg-critical-soft px-3 py-3">
      <p className="flex items-center gap-2 font-display text-base font-semibold text-critical">
        <AlertTriangle aria-hidden className="size-5" />
        La reconstrucción falló
      </p>
      <p className="text-sm text-text">{rec.error || rec.message}</p>
      <p className="text-xs text-muted">
        {rec.finished_at ? `Terminó el ${formatDateTime(rec.finished_at)}. ` : ""}
        Suele pasar cuando hay pocos ángulos o los cuadros no se parecen entre sí: suma videos desde otros puntos o
        despliega el dron y vuelve a intentarlo.
      </p>
      <Button icon={RefreshCw} onClick={onStart} loading={busy} disabled={!canStart}>
        Reintentar
      </Button>
    </div>
  );
}

function Ready({ rec, incident, media }: { rec: Reconstruction; incident: Incident; media: MediaView[] }) {
  const demo = rec.backend === "demo";
  const used = rec.media_ids
    .map((id) => media.find((m) => m.id === id))
    .filter((m): m is MediaView => Boolean(m))
    .map((m) => (m.source === "drone" ? `${m.label} (dron)` : m.label));
  const geo = demo ? null : geometricConfidence(rec);

  return (
    <div className="space-y-3">
      {demo && (
        <div
          role="note"
          className="flex items-start gap-2.5 rounded-md border border-warning/50 bg-warning-soft px-3 py-2.5 text-sm text-text"
        >
          <FlaskConical aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
          <span>
            <strong className="font-semibold">{SYNTHETIC_LABEL}</strong>
            <span className="block text-muted">
              Muestra lo que infirió la IA (estructuras, fuego, humo, vehículos, personas); no reconstruye las
              imágenes ni sirve para medir.
            </span>
          </span>
        </div>
      )}
      {demo && incident.scene_engine === "simulated" && <SimulatedNotice compact what="El esquema de la escena" />}

      {rec.splat_path ? (
        <SplatViewer
          url={fileUrl(rec.splat_path)}
          transform={rec.transform}
          scaleKnown={rec.scale_known}
          className="h-[min(62vh,520px)] min-h-[300px] w-full"
        />
      ) : (
        <p className="text-sm text-muted">La reconstrucción no tiene archivo para mostrar.</p>
      )}

      <div className="flex flex-wrap gap-1.5">
        {demo ? (
          <>
            <Badge tone="warning" icon={FlaskConical}>
              Sin GPU · sintética
            </Badge>
            <Badge tone="info" title="Posiciones y tamaños estimados por la IA a partir de los videos.">
              Ubicada según el esquema de la IA
            </Badge>
            <Badge tone="warning" icon={Ruler}>
              Escala estimada por la IA
            </Badge>
          </>
        ) : (
          <>
            <Badge tone={alignmentTone[rec.alignment]} title={alignmentHint[rec.alignment]}>
              {alignmentLabel[rec.alignment]}
            </Badge>
            <Badge tone={rec.scale_known ? "ok" : "warning"} icon={Ruler}>
              {rec.scale_known ? "Escala métrica conocida" : "Escala desconocida"}
            </Badge>
            <Badge tone="info" icon={Cpu}>
              {rec.gpu ? `GPU ${rec.gpu}` : "GPU en la nube"}
              {rec.gpu_seconds !== null ? ` · ${formatDuration(rec.gpu_seconds)}` : ""}
            </Badge>
            <Badge tone={rec.frames_registered === null ? "neutral" : "info"}>
              {rec.frames_registered === null
                ? `${pluralize(rec.frame_count, "cuadro")} de entrada`
                : `${rec.frames_registered} de ${pluralize(rec.frame_count, "cuadro")} registrados`}
            </Badge>
          </>
        )}
        {rec.finished_at && (
          <Badge tone="neutral" title={formatDateTime(rec.finished_at)}>
            {`Generada ${formatDate(rec.finished_at)} · ${formatClock(rec.finished_at, { seconds: false })}`}
          </Badge>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        {demo ? (
          incident.scene && (
            <>
              <span className="text-muted">Esquema de la IA:</span>
              <ConfidenceMeter level={incident.scene.confidence} size="sm" />
            </>
          )
        ) : (
          geo && (
            <>
              <span className="text-muted">Geometría:</span>
              <ConfidenceMeter level={geo.level} size="sm" />
              <span className="text-xs text-muted">{geo.basis}</span>
            </>
          )
        )}
      </div>
      {!demo && used.length > 0 && (
        <p className="text-xs text-muted">
          Entrenada con {used.join(", ")}
          {rec.iterations !== null ? ` · ${formatNumber(rec.iterations)} iteraciones` : ""}
          {rec.gaussians !== null ? ` · ${formatNumber(rec.gaussians)} gaussianas` : ""}.
        </p>
      )}

      <p className="flex items-start gap-2 rounded-md border border-line bg-surface-2 px-3 py-2 text-xs text-muted">
        <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
        <span>
          Una reconstrucción 3D no detecta personas: quienes se mueven no quedan registrados. Que no aparezcan aquí{" "}
          <strong className="text-text">no descarta víctimas</strong>.
        </span>
      </p>
    </div>
  );
}

/** La más reciente entre la del snapshot y la que devolvió el POST (que llega antes que el próximo sondeo). */
function latest(a: Reconstruction | null, b: Reconstruction | null): Reconstruction | null {
  if (!a || !b) return a ?? b;
  if (a.id === b.id) return a;
  return Date.parse(b.requested_at) > Date.parse(a.requested_at) ? b : a;
}

export function ReconstructionPanel({ incident, media, mode, onChanged, className }: ReconstructionPanelProps) {
  const [launched, setLaunched] = useState<Reconstruction | null>(null);
  const rec = latest(incident.reconstruction ?? null, launched);
  const gpu = mode.splat === "cloud_run_gpu";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(15_000);
  const active = isReconstructionActive(rec);
  const stale = rec !== null && now !== null && isReconstructionStale(rec, now);
  const canStart = gpu ? media.some(isReconstructionEligible) : Boolean(incident.scene);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const { reconstruction } = await api.incidents.reconstruct(incident.id);
      setLaunched(reconstruction);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Reconstrucción 3D"
      icon={Box}
      badge={<StatusBadge rec={rec} stale={stale} />}
      actions={
        rec?.status === "ready" ? (
          <Button
            size="sm"
            variant="ghost"
            icon={RefreshCw}
            onClick={start}
            loading={busy}
            disabled={!canStart}
            aria-label={gpu ? "Reconstruir de nuevo" : "Regenerar la vista sintética"}
          >
            <span className="hidden sm:inline">{gpu ? "Reconstruir de nuevo" : "Regenerar"}</span>
          </Button>
        ) : null
      }
      className={className}
      bodyClassName="space-y-3"
    >
      {!rec && (
        <Intro incident={incident} media={media} gpu={gpu} busy={busy} canStart={canStart} onStart={start} />
      )}
      {rec && active && <Progress rec={rec} stale={stale} busy={busy} canStart={canStart} onStart={start} />}
      {rec?.status === "failed" && <Failed rec={rec} busy={busy} canStart={canStart} onStart={start} />}
      {rec?.status === "ready" && <Ready rec={rec} incident={incident} media={media} />}
      {error && (
        <p role="alert" className="flex items-start gap-2 text-sm text-critical">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      )}
    </Panel>
  );
}
