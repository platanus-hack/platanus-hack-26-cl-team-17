"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  Ban,
  BatteryMedium,
  Camera,
  CameraOff,
  CircleAlert,
  CircleCheck,
  Compass,
  Info,
  LocateFixed,
  LocateOff,
  MapPin,
  Play,
  RefreshCw,
  Square,
  Sun,
  TriangleAlert,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { Button, ConfirmDialog, Spinner, useNow } from "@/components/ui";
import { api } from "@/lib/client/api";
import { captureVideoElementFrame } from "@/lib/client/frames";
import { LIMITS, type DroneMission, type Incident } from "@/lib/domain";
import { distanceM } from "@/lib/geo";
import { formatDistance, formatDuration, formatHeading, pluralize } from "@/lib/format";
import { cn } from "@/lib/cn";
import { SensorController, type SensorInputs, type SensorTransport } from "./controller";
import { useLiveStream } from "./use-live-stream";
import {
  BATCH_SIZE,
  commandView,
  createSession,
  gpsState,
  INSECURE_MESSAGE,
  isRetrying,
  SENSOR_TIMING,
  vibrationPattern,
  type SessionState,
} from "./core";
import { requestCompassPermission, useBatteryLevel, useCamera, useCompassWatch, useGpsWatch, useWakeLock } from "./devices";
import { SensorFrame } from "./SensorGate";

export interface SensorViewProps {
  token: string;
  mission: Pick<DroneMission, "id" | "label" | "mode" | "pattern" | "radius_m" | "altitude_m" | "status" | "command">;
  incident: Pick<Incident, "title" | "address" | "code" | "lat" | "lng"> | null;
}

const noopSubscribe = () => () => undefined;

function planText(m: SensorViewProps["mission"]): string {
  const alt = `${Math.round(m.altitude_m)} m de altura`;
  if (m.pattern === "hover") return `Punto fijo · ${alt}`;
  return `${m.pattern === "grid" ? "Barrido" : "Órbita"} de ${Math.round(m.radius_m)} m · ${alt}`;
}

type ChipTone = "ok" | "warning" | "critical" | "neutral";
// Van sobre la imagen de la cámara: relleno sólido para que se lean con cualquier escena y tema.
const CHIP: Record<ChipTone, string> = {
  ok: "bg-ok/90 text-on-solid border-white/20",
  warning: "bg-warning/90 text-on-solid border-white/20",
  critical: "bg-critical/90 text-on-solid border-white/20",
  neutral: "bg-black/60 text-white border-white/20",
};

function OverlayChip({ icon: Icon, tone, children }: { icon: LucideIcon; tone: ChipTone; children: ReactNode }) {
  return (
    <span className={cn("flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-xs font-semibold backdrop-blur-sm", CHIP[tone])}>
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      {children}
    </span>
  );
}

function Counter({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-md border border-line bg-surface px-3 py-2">
      <span className="label-caps truncate text-[11px] text-muted">{label}</span>
      <span className="font-display text-3xl leading-none font-semibold tabular">{value}</span>
      {hint && <span className="truncate text-[11px] text-faint">{hint}</span>}
    </div>
  );
}

type CheckState = "pending" | "ok" | "warn" | "error";
function CheckRow({ icon: Icon, label, state, detail }: { icon: LucideIcon; label: string; state: CheckState; detail: string }) {
  const tone = state === "ok" ? "text-ok" : state === "error" ? "text-critical" : state === "warn" ? "text-warning" : "text-muted";
  const StateIcon = state === "ok" ? CircleCheck : state === "error" ? CircleAlert : state === "warn" ? TriangleAlert : Info;
  return (
    <li className="flex items-start gap-3 py-2">
      <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-text">{label}</p>
        <p className={cn("text-sm", tone)}>{detail}</p>
      </div>
      <StateIcon aria-hidden="true" className={cn("mt-0.5 size-5 shrink-0", tone)} />
    </li>
  );
}

/** Modo sensor: el teléfono hace de dron (cámara trasera, GPS y brújula) y envía al puesto de mando. */
export function SensorView({ token, mission, incident }: SensorViewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const camera = useCamera(videoRef);
  const gps = useGpsWatch();
  const compass = useCompassWatch();
  const battery = useBatteryLevel();
  const now = useNow(1000);
  const secure = useSyncExternalStore(noopSubscribe, () => window.isSecureContext, () => true);

  const [session, setSession] = useState<SessionState>(createSession);
  const [confirmStop, setConfirmStop] = useState(false);
  const controllerRef = useRef<SensorController | null>(null);
  const active = session.phase === "running" || session.phase === "stopping";
  const wake = useWakeLock(active);
  const live = useLiveStream({
    active: session.phase === "running",
    videoRef,
    cameraReadyRef: camera.readyRef,
    missionId: mission.id,
    token,
  });

  const { readyRef: cameraReadyRef, stop: stopCamera } = camera;
  const { fixRef, stop: stopGps } = gps;
  const { readingRef: compassRef, stop: stopCompass } = compass;
  const { pctRef: batteryRef } = battery;

  const stopDevices = useCallback(() => {
    stopCamera();
    stopGps();
    stopCompass();
  }, [stopCamera, stopGps, stopCompass]);

  useEffect(() => {
    const transport: SensorTransport = {
      telemetry: (body, signal) => api.drone.telemetry(mission.id, token, body, { signal }),
      frame: (blob, meta, flush, signal) =>
        api.drone.frame(
          mission.id,
          token,
          blob,
          // Sin posición: NaN se omite de la query y el servidor usa la última telemetría.
          { lat: meta.lat ?? Number.NaN, lng: meta.lng ?? Number.NaN, alt: meta.alt, heading: meta.heading, t: meta.t, flush },
          { signal },
        ),
    };
    const inputs: SensorInputs = {
      fix: () => fixRef.current,
      compass: () => compassRef.current,
      battery: () => batteryRef.current,
      cameraReady: () => cameraReadyRef.current,
      capture: () => {
        const video = videoRef.current;
        if (!video) return Promise.reject(new Error("La cámara no está lista."));
        return captureVideoElementFrame(video, LIMITS.FRAME_LONG_EDGE_PX);
      },
    };
    const c = new SensorController(transport, inputs, (s) => {
      setSession(s);
      if (s.phase === "stopped") stopDevices();
    });
    controllerRef.current = c;
    return () => {
      c.dispose();
      controllerRef.current = null;
    };
  }, [mission.id, token, fixRef, compassRef, batteryRef, cameraReadyRef, stopDevices]);

  // Una vibración por cada orden nueva del mando.
  const lastSeq = useRef(0);
  useEffect(() => {
    if (session.commandSeq === lastSeq.current) return;
    lastSeq.current = session.commandSeq;
    const pattern = vibrationPattern(session.command);
    if (pattern && typeof navigator !== "undefined" && typeof navigator.vibrate === "function") navigator.vibrate(pattern);
  }, [session.commandSeq, session.command]);

  const onStart = () => {
    // iOS: el permiso de la brújula se pide dentro del gesto, antes de cualquier await.
    const compassPermission = requestCompassPermission();
    void compass.start(compassPermission);
    gps.start();
    void camera.start();
    controllerRef.current?.start();
  };

  const onStop = () => {
    controllerRef.current?.stop();
    setConfirmStop(false);
  };

  /* ───── Derivados para la interfaz ───── */
  const nowMs = now ?? 0;
  const fix = gps.state.fix;
  const gpsNow = now === null ? "waiting" : gpsState(fix, gps.state.error, nowMs);
  const known = session.telemetrySends > 0 || session.framesSent > 0;
  const command = known ? session.command : mission.command;
  const cmd = commandView(command);
  const distance = fix && incident ? distanceM({ lat: incident.lat, lng: incident.lng }, fix) : null;
  const lastOk = Math.max(session.telemetry.lastOkAt ?? 0, session.frame.lastOkAt ?? 0);
  const lastOkAge = lastOk > 0 && now !== null ? Math.max(0, Math.round((nowMs - lastOk) / 1000)) : null;
  const stopped = session.phase === "stopped";
  const retrying = isRetrying(session);
  const retryLines = (["telemetry", "frame"] as const)
    .filter((ch) => session[ch].failures > 0 && session[ch].error)
    .map((ch) => {
      const wait = Math.max(0, Math.ceil((session[ch].nextAt - nowMs) / 1000));
      return `${ch === "telemetry" ? "Posición" : "Cuadro"}: ${session[ch].error} Reintento en ${wait} s.`;
    });

  const gpsChip =
    gpsNow === "ok" && fix
      ? { tone: "ok" as const, icon: LocateFixed, text: `GPS ±${Math.max(1, Math.round(fix.accuracy_m))} m` }
      : gpsNow === "waiting" && !gps.state.error
        ? { tone: "neutral" as const, icon: LocateFixed, text: active ? "Buscando GPS…" : "GPS" }
        : { tone: "critical" as const, icon: LocateOff, text: "SIN GPS" };
  const compassChip =
    compass.status === "ok"
      ? { tone: "ok" as const, text: formatHeading(compass.deg) }
      : compass.status === "waiting"
        ? { tone: "neutral" as const, text: "Brújula…" }
        : compass.status === "unavailable"
          ? { tone: "warning" as const, text: "Sin brújula" }
          : { tone: "neutral" as const, text: "Brújula" };


  return (
    <SensorFrame>
      <main className="flex flex-1 flex-col gap-3 px-4 pb-[calc(6rem+env(safe-area-inset-bottom))]">
        {/* Misión */}
        <div className="flex flex-col gap-0.5">
          <h1 className="flex items-baseline gap-2 font-display text-3xl leading-none font-bold">
            <span className="text-drone">Dron {mission.label}</span>
            <span className="text-sm font-medium text-muted">{planText(mission)}</span>
          </h1>
          {incident && <p className="line-clamp-2 font-display text-lg leading-tight font-semibold text-text">{incident.title}</p>}
        </div>

        {!secure && (
          <p role="alert" className="flex items-start gap-2 rounded-md border border-critical/40 bg-critical-soft px-3 py-2 text-sm text-critical">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {INSECURE_MESSAGE}
          </p>
        )}

        {/* Orden del mando, en grande */}
        {cmd && !stopped && (
          <div
            role="alert"
            className={cn(
              "flex flex-col gap-1 rounded-lg px-4 py-3 text-on-solid",
              cmd.tone === "critical" ? "animate-pulse-critical bg-critical" : "bg-warning",
            )}
          >
            <p className="flex items-center gap-3 font-display text-5xl leading-none font-bold">
              {cmd.tone === "critical" ? <Ban aria-hidden="true" className="size-10" /> : <Undo2 aria-hidden="true" className="size-10" />}
              {cmd.word}
            </p>
            <p className="text-base font-semibold">{cmd.detail}</p>
          </div>
        )}

        {/* Vista previa */}
        <div className="relative aspect-[4/3] w-full overflow-hidden rounded-lg border border-line bg-black">
          <video
            ref={videoRef}
            muted
            playsInline
            autoPlay
            aria-label="Vista previa de la cámara trasera"
            className={cn("size-full object-cover", camera.state.status !== "ready" && "opacity-0")}
          />
          {camera.state.status !== "ready" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center text-sm text-white/80">
              {camera.state.status === "starting" ? (
                <Spinner size="md" label="Encendiendo la cámara" />
              ) : camera.state.status === "error" ? (
                <>
                  <CameraOff aria-hidden="true" className="size-8 text-critical" />
                  <p className="text-critical">{camera.state.error}</p>
                  {!stopped && (
                    <Button size="sm" icon={RefreshCw} onClick={() => void camera.start()}>
                      Reintentar cámara
                    </Button>
                  )}
                </>
              ) : (
                <>
                  <Camera aria-hidden="true" className="size-8" />
                  <p>{stopped ? "Cámara apagada." : "La cámara trasera se enciende al tocar «Iniciar envío»."}</p>
                </>
              )}
            </div>
          )}
          {!stopped && (
            <div className="pointer-events-none absolute inset-x-2 top-2 flex flex-wrap justify-between gap-1">
              <OverlayChip icon={gpsChip.icon} tone={gpsChip.tone}>
                {gpsChip.text}
              </OverlayChip>
              <OverlayChip icon={Compass} tone={compassChip.tone}>
                {compassChip.text}
              </OverlayChip>
            </div>
          )}
          {active && (
            <div className="pointer-events-none absolute inset-x-2 bottom-2 flex items-center justify-between gap-1">
              <OverlayChip icon={Camera} tone={live.status === "live" ? "ok" : live.status === "retrying" ? "warning" : "neutral"}>
                <span className={cn("inline-block size-2 rounded-full bg-critical", live.status === "live" && "animate-pulse")} aria-hidden="true" />
                {live.status === "live"
                  ? `EN VIVO · ${live.fps.toLocaleString("es-CL")} c/s`
                  : live.status === "retrying"
                    ? "VIDEO: REINTENTANDO"
                    : live.status === "ended"
                      ? "VIDEO CORTADO"
                      : "CONECTANDO VIDEO"}
              </OverlayChip>
              {camera.state.rear === false && (
                <OverlayChip icon={TriangleAlert} tone="warning">
                  Cámara frontal
                </OverlayChip>
              )}
            </div>
          )}
        </div>

        {/* Estado del envío */}
        {session.phase === "idle" ? (
          <section aria-label="Antes de empezar" className="flex flex-col gap-1">
            <p className="text-base leading-relaxed text-muted">
              Este teléfono enviará al puesto de mando su <strong className="text-text">ubicación y rumbo cada 2 s</strong>,{" "}
              <strong className="text-text">video en vivo</strong> (unos 3 cuadros por segundo, en baja resolución) y{" "}
              <strong className="text-text">una foto cada 5 s</strong> (la IA las analiza en lotes de {BATCH_SIZE}). Apunta la cámara
              trasera al incidente y mantén la pantalla encendida.
            </p>
            <ul className="divide-y divide-line">
              <CheckRow
                icon={Camera}
                label="Cámara trasera"
                state={camera.state.status === "error" ? "error" : "pending"}
                detail={camera.state.error ?? "Te pediremos permiso al iniciar."}
              />
              <CheckRow
                icon={MapPin}
                label="Ubicación (GPS)"
                state={gps.state.error ? "error" : "pending"}
                detail={gps.state.error ?? "Alta precisión; actívala si el teléfono la tiene apagada."}
              />
              <CheckRow icon={Compass} label="Brújula" state="pending" detail="Opcional: indica hacia dónde mira la cámara." />
              <CheckRow icon={Sun} label="Pantalla encendida" state="pending" detail="La mantenemos encendida mientras envías." />
            </ul>
          </section>
        ) : (
          <section aria-label="Envío al puesto de mando" className="flex flex-col gap-2">
            <div className="grid grid-cols-2 gap-2">
              <Counter label="Posiciones enviadas" value={session.pointsSent} hint={`Cada ${SENSOR_TIMING.telemetryEveryMs / 1000} s`} />
              <Counter label="Cuadros enviados" value={session.framesSent} hint={`Cada ${SENSOR_TIMING.frameEveryMs / 1000} s`} />
              <Counter label="Lote actual" value={`${session.batchFrames}/${BATCH_SIZE}`} hint="Se analiza al completarse" />
              <Counter label="Lotes a análisis" value={session.batchesClosed} hint={session.mediaId ? "Recibidos por el mando" : undefined} />
            </div>
            <p role="status" className={cn("flex items-center gap-2 text-sm", retrying ? "text-warning" : "text-muted")}>
              {retrying ? <TriangleAlert aria-hidden="true" className="size-4 shrink-0" /> : <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-ok" />}
              {lastOkAge === null
                ? active
                  ? "Conectando con el puesto de mando…"
                  : "Sin envíos."
                : `Último envío recibido hace ${formatDuration(lastOkAge)}.`}
              {distance !== null && <span className="ml-auto shrink-0 text-faint">A {formatDistance(distance)} del incidente</span>}
            </p>
            {retryLines.map((line) => (
              <p key={line} className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning">
                <RefreshCw aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                {line}
              </p>
            ))}
            {gps.state.error && !stopped && (
              <p className="flex items-start gap-2 text-sm text-critical">
                <LocateOff aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                <span>
                  {gps.state.error} {gps.state.denied ? "Sin ubicación los cuadros llegan sin posición." : ""}
                </span>
              </p>
            )}
            {session.notice && !stopped && <p className="text-xs text-faint">{session.notice}</p>}
            {session.droppedPoints > 0 && (
              <p className="text-xs text-faint">
                Se descartaron {pluralize(session.droppedPoints, "posición antigua", "posiciones antiguas")} por falta de conexión.
              </p>
            )}
            {active && (
              <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-faint">
                <span className="flex items-center gap-1">
                  <Sun aria-hidden="true" className="size-3" />
                  {wake === "on" ? "Pantalla se mantiene encendida" : wake === "unsupported" ? "No apagues la pantalla" : "Mantén la pantalla encendida"}
                </span>
                {battery.pct !== null && (
                  <span className="flex items-center gap-1">
                    <BatteryMedium aria-hidden="true" className="size-3" />
                    Batería {battery.pct} %
                  </span>
                )}
              </p>
            )}
            {stopped && session.stop && (
              <div
                role={session.stop.tone === "critical" ? "alert" : "status"}
                className={cn(
                  "flex flex-col gap-2 rounded-lg border p-3 text-base",
                  session.stop.tone === "ok" && "border-ok/40 bg-ok-soft text-text",
                  session.stop.tone === "warning" && "border-warning/40 bg-warning-soft text-text",
                  session.stop.tone === "critical" && "border-critical/40 bg-critical-soft text-text",
                )}
              >
                <p className="flex items-start gap-2">
                  {session.stop.tone === "ok" ? (
                    <CircleCheck aria-hidden="true" className="mt-1 size-5 shrink-0 text-ok" />
                  ) : (
                    <CircleAlert aria-hidden="true" className={cn("mt-1 size-5 shrink-0", session.stop.tone === "critical" ? "text-critical" : "text-warning")} />
                  )}
                  <span>{session.stop.message}</span>
                </p>
                <p className="text-sm text-muted">
                  Ya puedes cerrar esta página. Para volver a enviar, pide al puesto de mando que despliegue un dron nuevo.
                </p>
              </div>
            )}
          </section>
        )}
      </main>

      {/* Botón principal fijo abajo */}
      {!stopped && (
        <div className="fixed inset-x-0 bottom-0 border-t border-line bg-bg/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
          {session.phase === "idle" ? (
            <Button variant="primary" size="xl" icon={Play} fullWidth onClick={onStart} disabled={!secure}>
              Iniciar envío
            </Button>
          ) : (
            <Button
              variant="danger"
              size="xl"
              icon={Square}
              fullWidth
              loading={session.phase === "stopping"}
              onClick={() => setConfirmStop(true)}
            >
              {session.phase === "stopping" ? "Deteniendo…" : "Detener"}
            </Button>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmStop}
        onClose={() => setConfirmStop(false)}
        onConfirm={onStop}
        title="¿Detener el envío?"
        description={
          command === "abort"
            ? "Avisaremos al puesto de mando que la misión quedó abortada. Aterriza en un lugar seguro."
            : "Enviaremos el último cuadro y avisaremos al puesto de mando que el dron está en tierra. La misión quedará cerrada."
        }
        confirmLabel="Detener"
        danger
      />
    </SensorFrame>
  );
}
