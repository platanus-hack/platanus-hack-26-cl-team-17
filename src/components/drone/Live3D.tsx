"use client";
/**
 * Reconstrucción 3D en vivo del dron (servicio vigia-live3d, gpu/splat/LIVE3D.md).
 *
 * - Sin servicio configurado no se muestra nada (una sola consulta al montar).
 * - Con la vista abierta consulta el estado cada ~1 s (nunca dos consultas a la vez, pausa con
 *   la pestaña oculta) y baja los trozos de puntos que faltan, de a 8.
 * - El lienzo three.js (Live3DCanvas) se carga aparte con next/dynamic, solo en el navegador.
 * - Los datos viven aquí: cerrar o ampliar la vista no vuelve a bajar la nube.
 * - Vista «Gaussian splats» (solo en la pestaña de la ficha): mientras está elegida y visible pide
 *   la última instantánea cada ~2 s; eso es lo que mantiene el entrenamiento encendido en el
 *   servicio (se apaga solo ~20 s después de la última consulta). Lienzo aparte: Live3DSplatCanvas.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import { Box, Maximize2, RotateCcw, Sparkles, TriangleAlert, X } from "lucide-react";
import { Badge, Button, IconButton, Spinner, useNow } from "@/components/ui";
import { ViewerErrorBoundary } from "@/components/scene3d/error-boundary";
import { cn } from "@/lib/cn";
import { formatNumber, timeAgo } from "@/lib/format";
import { parseLive3dChunk, PointCloudBuffer } from "@/lib/drone/live3d-points";
import { parseLiveSplat, type LiveSplat } from "@/lib/drone/live3d-splat";
import type { Live3DSceneResponse, Live3DStatus } from "@/lib/drone/live3d-types";

const STATUS_POLL_MS = 1000;
/** Si quedan trozos por bajar, la próxima vuelta va casi de inmediato. */
const CATCHUP_POLL_MS = 120;
const RETRY_MS = 3000;
const CHUNKS_PER_REQUEST = 8;
/** Cada cuánto se pide la instantánea de splats (el servicio exporta una cada ~2,5 s, de ~4 MB). */
const SPLAT_POLL_MS = 2000;

export type Live3DMode = "points" | "splat";

const Live3DCanvas = dynamic(() => import("./Live3DCanvas"), {
  ssr: false,
  loading: () => (
    <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-white/75">
      <Spinner size="sm" label="" />
      Cargando vista 3D…
    </div>
  ),
});

const Live3DSplatCanvas = dynamic(() => import("./Live3DSplatCanvas"), {
  ssr: false,
  loading: () => (
    <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-white/75">
      <Spinner size="sm" label="" />
      Cargando vista de splats…
    </div>
  ),
});

interface Live3DData {
  status: Live3DStatus | null;
  cloud: PointCloudBuffer;
  /** Sube cada vez que la nube cambia (se mutan los mismos arreglos). */
  cloudVersion: number;
  /** Vacía la nube local y vuelve a consultar (después de reiniciar la sesión). */
  clear: () => void;
}

/** Estado y nube de la reconstrucción; solo consulta con `open`. */
function useLive3dData(missionId: string, open: boolean): Live3DData {
  const [cloud] = useState(() => new PointCloudBuffer());
  const [status, setStatus] = useState<Live3DStatus | null>(null);
  const [cloudVersion, setCloudVersion] = useState(0);
  const [kick, setKick] = useState(0);
  // Progreso que sobrevive a cerrar y abrir la vista.
  const progress = useRef({ loaded: 0, version: -1, session: "" });

  useEffect(() => {
    if (!open) return;
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let running = false;
    const base = `/api/drone/${encodeURIComponent(missionId)}/live/scene3d`;

    const schedule = (ms: number) => {
      if (ctl.signal.aborted) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(poll, ms);
    };

    async function poll() {
      timer = null;
      if (ctl.signal.aborted || running || document.hidden) return;
      running = true;
      const started = Date.now();
      let next = STATUS_POLL_MS;
      try {
        const res = await fetch(base, { cache: "no-store", credentials: "same-origin", signal: ctl.signal });
        if (!res.ok) {
          next = RETRY_MS;
        } else {
          const body = (await res.json()) as Partial<Live3DSceneResponse>;
          const st = body.status ?? null;
          const p = progress.current;
          // Sesión nueva, reiniciada o que retrocedió: se vacía la nube. Sin estado (servicio
          // caído un momento o sesión borrada) se conserva lo que ya se ve.
          if (st && (st.session !== p.session || st.chunks < p.loaded || st.version < p.version)) {
            if (p.loaded > 0 || cloud.count > 0) {
              cloud.reset();
              setCloudVersion((v) => v + 1);
            }
            p.loaded = 0;
          }
          if (st) {
            p.session = st.session;
            p.version = st.version;
          }
          if (st && st.chunks > p.loaded) {
            const pts = await fetch(`${base}/points?from=${p.loaded}&max=${CHUNKS_PER_REQUEST}`, {
              cache: "no-store",
              credentials: "same-origin",
              signal: ctl.signal,
            });
            if (pts.ok) {
              const chunk = parseLive3dChunk(await pts.arrayBuffer());
              if (ctl.signal.aborted) return;
              if (chunk && chunk.from === p.loaded && chunk.to > chunk.from) {
                cloud.append(chunk.positions, chunk.colors);
                p.loaded = chunk.to;
                setCloudVersion((v) => v + 1);
                if (st.chunks > p.loaded) next = CATCHUP_POLL_MS;
              }
            } else {
              next = RETRY_MS;
            }
          }
          if (ctl.signal.aborted) return;
          if (st) setStatus(st);
          else if (cloud.count === 0) setStatus(null);
        }
      } catch {
        if (ctl.signal.aborted) return;
        next = RETRY_MS;
      } finally {
        running = false;
      }
      schedule(Math.max(0, next - (Date.now() - started)));
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
    };
  }, [missionId, open, cloud, kick]);

  const clear = useCallback(() => {
    cloud.reset();
    progress.current = { loaded: 0, version: -1, session: "" };
    setStatus(null);
    setCloudVersion((v) => v + 1);
    setKick((k) => k + 1);
  }, [cloud]);
  return { status, cloud, cloudVersion, clear };
}

interface LiveSplatData {
  /** Última instantánea de la misión (null = todavía ninguna). */
  splat: LiveSplat | null;
  clear: () => void;
}

/**
 * Instantáneas de los Gaussian splats en vivo; solo consulta con `active` y la pestaña visible.
 * Pedirlas es lo que mantiene encendido el entrenamiento en el servicio.
 */
function useLiveSplat(missionId: string, active: boolean): LiveSplatData {
  const [state, setState] = useState<{ mission: string; splat: LiveSplat } | null>(null);
  const version = useRef<{ mission: string; v: number }>({ mission: "", v: 0 });
  const [kick, setKick] = useState(0);

  useEffect(() => {
    if (!active || !missionId) return;
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const url = `/api/drone/${encodeURIComponent(missionId)}/live/scene3d/splat`;
    if (version.current.mission !== missionId) version.current = { mission: missionId, v: 0 };

    async function poll() {
      timer = null;
      if (ctl.signal.aborted) return;
      const started = Date.now();
      let next = SPLAT_POLL_MS;
      if (!document.hidden) {
        try {
          const res = await fetch(`${url}?after=${version.current.v}`, {
            cache: "no-store",
            credentials: "same-origin",
            signal: ctl.signal,
          });
          if (res.status === 200) {
            const parsed = parseLiveSplat(await res.arrayBuffer());
            if (ctl.signal.aborted) return;
            if (parsed) {
              version.current = { mission: missionId, v: parsed.version };
              setState({ mission: missionId, splat: parsed });
            }
          } else if (res.status !== 204) {
            next = RETRY_MS;
          }
        } catch {
          if (ctl.signal.aborted) return;
          next = RETRY_MS;
        }
      }
      if (!ctl.signal.aborted) timer = setTimeout(poll, Math.max(250, next - (Date.now() - started)));
    }

    const onVisibility = () => {
      if (!document.hidden && timer !== null) {
        clearTimeout(timer);
        timer = setTimeout(poll, 0);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    void poll();
    return () => {
      ctl.abort();
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [missionId, active, kick]);

  const clear = useCallback(() => {
    version.current = { mission: "", v: 0 };
    setState(null);
    setKick((k) => k + 1);
  }, []);
  return { splat: state && state.mission === missionId ? state.splat : null, clear };
}

/** Una consulta al montar: ¿hay servicio 3D configurado? */
export function useLive3dEnabled(missionId: string): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (!missionId) return;
    const ctl = new AbortController();
    fetch(`/api/drone/${encodeURIComponent(missionId)}/live/scene3d`, {
      cache: "no-store",
      credentials: "same-origin",
      signal: ctl.signal,
    })
      .then(async (res) => {
        if (!res.ok) return;
        const body = (await res.json()) as Partial<Live3DSceneResponse>;
        if (!ctl.signal.aborted) setEnabled(body.enabled === true);
      })
      .catch(() => undefined);
    return () => ctl.abort();
  }, [missionId]);
  return missionId ? enabled : false;
}

function agoText(updatedAt: number | null, now: number | null): string | null {
  if (updatedAt === null || now === null) return null;
  const s = Math.max(0, Math.round((now - updatedAt) / 1000));
  return s < 60 ? `hace ${s} s` : timeAgo(updatedAt, now);
}

interface ViewProps {
  data: Live3DData;
  expanded: boolean;
  /** Sin esto no hay botón de pantalla completa (la vista ya ocupa su lugar). */
  onExpand?: () => void;
  /** Video en vivo del dron en miniatura, abajo a la derecha. */
  pipMissionId?: string;
  onClose: () => void;
  onReset?: () => void;
  resetting?: boolean;
  /** Con esto aparece el selector «Nube de puntos · Gaussian splats» (si el servicio los trae). */
  mode?: Live3DMode;
  onModeChange?: (mode: Live3DMode) => void;
  splat?: LiveSplat | null;
  className?: string;
}

function Live3DView({
  data,
  expanded,
  onExpand,
  pipMissionId,
  onClose,
  onReset,
  resetting,
  mode = "points",
  onModeChange,
  splat = null,
  className,
}: ViewProps) {
  const now = useNow(1000);
  const [failed, setFailed] = useState(false);
  const { status, cloud, cloudVersion } = data;
  const hasPoints = status !== null && cloud.count > 0;
  const lost = status?.state === "lost";
  const ago = agoText(status?.updated_at ?? null, now);
  // Un servicio sin Gaussian splatting (versión anterior o LIVE3D_SPLAT=0) no muestra el selector.
  const splatInfo = status?.splat ?? null;
  const canSplat = onModeChange !== undefined && splatInfo !== null && splatInfo.engine !== null;
  const splatMode = canSplat && mode === "splat";
  const splatAgo = agoText(splatInfo?.updated_at ?? null, now);

  return (
    <div className={cn("relative isolate overflow-hidden bg-[#090b0f]", className)}>
      {hasPoints && !failed && (
        <ViewerErrorBoundary key={splatMode ? "splat" : "points"} onError={() => setFailed(true)}>
          <div className="absolute inset-0">
            {splatMode ? (
              <Live3DSplatCanvas status={status} cloud={cloud} cloudVersion={cloudVersion} splat={splat} />
            ) : (
              <Live3DCanvas status={status} cloud={cloud} cloudVersion={cloudVersion} />
            )}
          </div>
        </ViewerErrorBoundary>
      )}

      {splatMode && hasPoints && !failed && splat === null && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-sm text-white/80">
          <Spinner size="md" label="Entrenando" />
          {splatInfo?.error ?? "Entrenando Gaussian splats con el video del dron…"}
        </div>
      )}

      {failed ? (
        <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-white/75">
          Este navegador no pudo abrir la vista 3D.
        </div>
      ) : (
        !hasPoints && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-sm text-white/75">
            <Spinner size="md" label="Esperando video" />
            Esperando video del dron…
            {status?.message && <span className="max-w-sm text-xs text-white/60">{status.message}</span>}
          </div>
        )
      )}

      <div className="pointer-events-none absolute inset-x-2 top-2 flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col items-start gap-1">
          <span className="flex items-center gap-1.5 rounded-md bg-black/60 px-2 py-1 font-mono text-xs font-semibold text-white backdrop-blur-sm">
            <Box aria-hidden="true" className="size-3.5 shrink-0" />
            Reconstrucción 3D en vivo
          </span>
          {status?.engine === "fake" && (
            <Badge tone="warning" size="sm" variant="solid" title="Motor simulado, sin GPU: la nube no viene del video">
              Simulado
            </Badge>
          )}
          {canSplat && onModeChange && <ModeToggle mode={splatMode ? "splat" : "points"} onChange={onModeChange} />}
        </div>
        <div className="pointer-events-auto flex items-center gap-1.5">
          {onReset && (
            <IconButton
              icon={RotateCcw}
              label="Reiniciar la reconstrucción"
              size="sm"
              variant="secondary"
              loading={resetting}
              onClick={onReset}
            />
          )}
          {expanded ? (
            <IconButton icon={X} label="Cerrar pantalla completa" size="sm" variant="secondary" onClick={onClose} />
          ) : (
            onExpand && (
              <IconButton icon={Maximize2} label="Ver en pantalla completa" size="sm" variant="secondary" onClick={onExpand} />
            )
          )}
        </div>
      </div>

      {status && (hasPoints || lost) && (
        <div className="pointer-events-none absolute inset-x-2 bottom-2 flex flex-col items-start gap-1">
          {status.message && (
            <span
              className={cn(
                "flex max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold backdrop-blur-sm",
                lost ? "bg-warning/90 text-on-solid" : "bg-black/60 text-white/85",
              )}
            >
              {lost && <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />}
              <span className="truncate">{status.message}</span>
            </span>
          )}
          {splatMode && splatInfo?.error && splat !== null && (
            <span className="flex max-w-full items-center gap-1.5 rounded-md bg-warning/90 px-2 py-1 text-xs font-semibold text-on-solid backdrop-blur-sm">
              <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="truncate">{splatInfo.error}</span>
            </span>
          )}
          {hasPoints && splatMode && splatInfo && (
            <span className="flex items-center gap-1.5 rounded-md bg-black/60 px-2 py-1 font-mono text-xs text-white/85 tabular backdrop-blur-sm">
              {splatInfo.active && <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" aria-hidden="true" />}
              {formatNumber(splat?.count ?? splatInfo.gaussians)} gaussianas · {formatNumber(splatInfo.views)} vistas · paso{" "}
              {formatNumber(splatInfo.steps)}
              {splatAgo && ` · ${splatAgo}`}
            </span>
          )}
          {hasPoints && !splatMode && (
            <span className="rounded-md bg-black/60 px-2 py-1 font-mono text-xs text-white/85 tabular backdrop-blur-sm">
              {formatNumber(status.points)} puntos · {formatNumber(status.keyframes)} cuadros clave
              {ago && ` · ${ago}`}
            </span>
          )}
        </div>
      )}

      {pipMissionId && <LiveFramePip missionId={pipMissionId} />}
    </div>
  );
}

const MODES: { value: Live3DMode; label: string; icon: typeof Box; title: string }[] = [
  { value: "points", label: "Nube de puntos", icon: Box, title: "Puntos de VGGT: lo más rápido, se arma al instante" },
  {
    value: "splat",
    label: "Gaussian splats",
    icon: Sparkles,
    title: "Gaussian splatting entrenado en vivo con el video del dron (se entrena solo mientras esta vista está abierta)",
  },
];

/** «Nube de puntos · Gaussian splats», con el estilo de los rótulos sobre la escena. */
function ModeToggle({ mode, onChange }: { mode: Live3DMode; onChange: (m: Live3DMode) => void }) {
  return (
    <div
      role="radiogroup"
      aria-label="Tipo de reconstrucción"
      className="pointer-events-auto flex gap-0.5 rounded-md bg-black/60 p-0.5 backdrop-blur-sm"
    >
      {MODES.map((m) => {
        const Icon = m.icon;
        const on = mode === m.value;
        return (
          <button
            key={m.value}
            type="button"
            role="radio"
            aria-checked={on}
            title={m.title}
            onClick={() => onChange(m.value)}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded px-2 text-xs font-semibold transition-colors",
              on ? "bg-white/90 text-black" : "text-white/75 hover:text-white",
            )}
          >
            <Icon className="size-3.5" aria-hidden="true" />
            {m.label}
          </button>
        );
      })}
    </div>
  );
}

const PIP_POLL_MS = 200;

/** Último cuadro del video en vivo (mismo endpoint que LiveFeed), en miniatura sobre la nube. */
function LiveFramePip({ missionId }: { missionId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    let seq: string | null = null;
    let current: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function poll() {
      if (ctl.signal.aborted) return;
      if (!document.hidden) {
        try {
          const q = seq ? `?after=${encodeURIComponent(seq)}` : "";
          const res = await fetch(`/api/drone/${encodeURIComponent(missionId)}/live${q}`, {
            cache: "no-store",
            credentials: "same-origin",
            signal: ctl.signal,
          });
          if (res.status === 200) {
            seq = res.headers.get("x-live-seq");
            const next = URL.createObjectURL(await res.blob());
            if (current) URL.revokeObjectURL(current);
            current = next;
            setUrl(next);
          }
        } catch {
          // Sin cuadro nuevo o red caída: se reintenta en la próxima vuelta.
        }
      }
      if (!ctl.signal.aborted) timer = setTimeout(poll, PIP_POLL_MS);
    }
    void poll();
    return () => {
      ctl.abort();
      if (timer !== null) clearTimeout(timer);
      if (current) URL.revokeObjectURL(current);
    };
  }, [missionId]);
  if (!url) return null;
  return (
    <div className="pointer-events-none absolute bottom-2 right-2 w-[26%] min-w-40 max-w-80 overflow-hidden rounded-md border border-white/20 shadow-lg">
      {/* eslint-disable-next-line @next/next/no-img-element -- cuadro en vivo desde un blob local */}
      <img src={url} alt="Video en vivo del dron" className="block w-full" />
      <span className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-white">
        <span className="size-1.5 rounded-full bg-red-500" aria-hidden="true" />
        EN VIVO
      </span>
    </div>
  );
}

export interface Live3DStageProps {
  missionId: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * La reconstrucción como vista principal (pestaña de la ficha): siempre abierta, sin botón de
 * ampliar y con el video en vivo en miniatura. Quien la usa ya comprobó que el servicio existe.
 */
export function Live3DStage({ missionId, className, style }: Live3DStageProps) {
  const data = useLive3dData(missionId, true);
  const [mode, setMode] = useState<Live3DMode>("points");
  // Solo con «Gaussian splats» elegido (y un servicio que los trae) se piden y se entrenan.
  const splatOn = mode === "splat" && data.status?.splat?.engine != null;
  const live = useLiveSplat(missionId, splatOn);
  const { clear: clearPoints } = data;
  const { clear: clearSplat } = live;
  const clear = useCallback(() => {
    clearPoints();
    clearSplat();
  }, [clearPoints, clearSplat]);
  const { reset, resetting } = useLive3dReset(missionId, clear);
  return (
    <div className={className} style={style}>
      <Live3DView
        data={data}
        expanded={false}
        pipMissionId={missionId}
        onClose={() => undefined}
        onReset={() => void reset()}
        resetting={resetting}
        mode={mode}
        onModeChange={setMode}
        splat={live.splat}
        className="size-full"
      />
    </div>
  );
}

/** Borra la sesión en el servicio (la nube vuelve a armarse con los cuadros que siguen llegando). */
function useLive3dReset(missionId: string, clear: () => void) {
  const [resetting, setResetting] = useState(false);
  const reset = useCallback(async () => {
    setResetting(true);
    try {
      const res = await fetch(`/api/drone/${encodeURIComponent(missionId)}/live/scene3d/reset`, {
        method: "POST",
        credentials: "same-origin",
      });
      if (res.ok) clear();
    } catch {
      // Si falla, la vista sigue con lo que tenía.
    } finally {
      setResetting(false);
    }
  }, [missionId, clear]);
  return { reset, resetting };
}

export interface Live3DPanelProps {
  missionId: string;
  className?: string;
}

/** Botón «3D en vivo» y la vista (bajo el video o en pantalla completa). Sin servicio no muestra nada. */
export function Live3DPanel({ missionId, className }: Live3DPanelProps) {
  const enabled = useLive3dEnabled(missionId);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [resetting, setResetting] = useState(false);
  const data = useLive3dData(missionId, enabled && open);
  const { clear } = data;

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [expanded]);

  const reset = useCallback(async () => {
    setResetting(true);
    try {
      const res = await fetch(`/api/drone/${encodeURIComponent(missionId)}/live/scene3d/reset`, {
        method: "POST",
        credentials: "same-origin",
      });
      if (res.ok) clear();
    } catch {
      // Si falla, la vista sigue con lo que tenía.
    } finally {
      setResetting(false);
    }
  }, [missionId, clear]);

  if (!enabled) return null;

  const close = () => setExpanded(false);
  const toggle = () => {
    setOpen((o) => !o);
    setExpanded(false);
  };

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-center gap-2">
        <Button size="sm" variant={open ? "primary" : "secondary"} icon={Box} aria-pressed={open} onClick={toggle}>
          3D en vivo
        </Button>
      </div>
      {open && !expanded && (
        <Live3DView
          data={data}
          expanded={false}
          onExpand={() => setExpanded(true)}
          onClose={close}
          className="h-[260px] w-full rounded-md border border-line"
        />
      )}
      {open &&
        expanded &&
        createPortal(
          <div className="fixed inset-0 z-50 bg-black" role="dialog" aria-modal="true" aria-label="Reconstrucción 3D en vivo">
            <Live3DView
              data={data}
              expanded
              onExpand={() => setExpanded(true)}
              onClose={close}
              onReset={() => void reset()}
              resetting={resetting}
              className="size-full"
            />
          </div>,
          document.body,
        )}
    </div>
  );
}
