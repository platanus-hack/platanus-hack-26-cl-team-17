"use client";
/**
 * Reconstrucción 3D en vivo del dron (servicio vigia-live3d, gpu/splat/LIVE3D.md).
 *
 * - Sin servicio configurado no se muestra nada (una sola consulta al montar).
 * - Con la vista abierta consulta el estado cada ~1 s (nunca dos consultas a la vez, pausa con
 *   la pestaña oculta) y baja los trozos de puntos que faltan, de a 8.
 * - El lienzo three.js (Live3DCanvas) se carga aparte con next/dynamic, solo en el navegador.
 * - Los datos viven aquí: cerrar o ampliar la vista no vuelve a bajar la nube.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import { Box, Maximize2, RotateCcw, TriangleAlert, X } from "lucide-react";
import { Badge, Button, IconButton, Spinner, useNow } from "@/components/ui";
import { ViewerErrorBoundary } from "@/components/scene3d/error-boundary";
import { cn } from "@/lib/cn";
import { formatNumber, timeAgo } from "@/lib/format";
import { parseLive3dChunk, PointCloudBuffer } from "@/lib/drone/live3d-points";
import type { Live3DSceneResponse, Live3DStatus } from "@/lib/drone/live3d-types";

const STATUS_POLL_MS = 1000;
/** Si quedan trozos por bajar, la próxima vuelta va casi de inmediato. */
const CATCHUP_POLL_MS = 120;
const RETRY_MS = 3000;
const CHUNKS_PER_REQUEST = 8;

const Live3DCanvas = dynamic(() => import("./Live3DCanvas"), {
  ssr: false,
  loading: () => (
    <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-white/75">
      <Spinner size="sm" label="" />
      Cargando vista 3D…
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
  className?: string;
}

function Live3DView({ data, expanded, onExpand, pipMissionId, onClose, onReset, resetting, className }: ViewProps) {
  const now = useNow(1000);
  const [failed, setFailed] = useState(false);
  const { status, cloud, cloudVersion } = data;
  const hasPoints = status !== null && cloud.count > 0;
  const lost = status?.state === "lost";
  const ago = agoText(status?.updated_at ?? null, now);

  return (
    <div className={cn("relative isolate overflow-hidden bg-[#090b0f]", className)}>
      {hasPoints && !failed && (
        <ViewerErrorBoundary onError={() => setFailed(true)}>
          <div className="absolute inset-0">
            <Live3DCanvas status={status} cloud={cloud} cloudVersion={cloudVersion} />
          </div>
        </ViewerErrorBoundary>
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
          {hasPoints && (
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
  const { reset, resetting } = useLive3dReset(missionId, data.clear);
  return (
    <div className={className} style={style}>
      <Live3DView
        data={data}
        expanded={false}
        pipMissionId={missionId}
        onClose={() => undefined}
        onReset={() => void reset()}
        resetting={resetting}
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
