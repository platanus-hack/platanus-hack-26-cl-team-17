/**
 * Núcleo puro del modo sensor: estado del ciclo de envío, planificación (qué se envía y cuándo),
 * reintentos con espera exponencial y traducción de errores a mensajes en español.
 * Sin globals del navegador: se prueba en node con `node --import tsx --test`.
 */
import type { DroneFrameResponse, TelemetryResponse } from "@/lib/contract";
import { LIMITS, type DroneMission, type MissionStatus, type TelemetryInput } from "@/lib/domain";

export type MissionCommand = DroneMission["command"];
export type TelemetryPointInput = TelemetryInput["points"][number];
export type ReportableStatus = NonNullable<TelemetryInput["status"]>;
export type Channel = "telemetry" | "frame";

export const SENSOR_TIMING = {
  /** Cada cuánto se toma (y se envía) un punto de telemetría. */
  telemetryEveryMs: 2000,
  /** Cada cuánto se envía un cuadro JPEG. */
  frameEveryMs: 5000,
  /** Margen para que la cámara entregue imagen antes del primer cuadro. */
  firstFrameDelayMs: 1500,
  retryBaseMs: 1000,
  retryMaxMs: 30_000,
  /** Una posición más antigua que esto deja la telemetría en pausa ("SIN GPS"). */
  gpsStaleMs: 15_000,
  /** Un rumbo de brújula más antiguo que esto se considera perdido. */
  compassStaleMs: 3000,
  /** Velocidad mínima para confiar en el rumbo de desplazamiento del GPS. */
  gpsCourseMinSpeedMs: 1,
  /** Tope de puntos acumulados sin enviar (el servidor acepta hasta 60 por envío). */
  maxPendingPoints: 60,
  /** Intentos de cada envío final al detener. */
  finalAttempts: 3,
  /** Plazo de una solicitud antes de darla por perdida. */
  telemetryTimeoutMs: 20_000,
  frameTimeoutMs: 45_000,
  /** Cada cuánto se reintenta capturar si la cámara aún no entrega imagen. */
  captureRetryMs: 2000,
} as const;

export const BATCH_SIZE = LIMITS.DRONE_BATCH_FRAMES;

/* ───────────── Errores ───────────── */

/** Lo mínimo de `ApiClientError` que necesitamos (o un error propio con `code: "timeout"`). */
export interface ErrorLike {
  status?: number;
  code?: string;
  message?: string;
}

export type StopCode = "user" | "invalid_token" | "not_found" | "aborted" | "ended_landed" | "ended_aborted";

export type ErrorDecision =
  | { kind: "retry"; message: string }
  | { kind: "drop"; message: string }
  | { kind: "fatal"; stop: StopCode; message: string }
  | { kind: "ignore" };

export const STOP_MESSAGES: Record<Exclude<StopCode, "user">, string> = {
  invalid_token:
    "Este enlace ya no es válido o el token es incorrecto. Pide un enlace nuevo en el panel del dron del puesto de mando.",
  not_found: "Esta misión no existe. Revisa que abriste el enlace completo que entregó el puesto de mando.",
  aborted: "El puesto de mando abortó la misión: ya no recibe cuadros. El envío se detuvo.",
  ended_landed: "El puesto de mando dio por terminada la misión (dron en tierra). El envío se detuvo.",
  ended_aborted: "La misión fue abortada desde el puesto de mando. El envío se detuvo.",
};

function asErrorLike(err: unknown): ErrorLike {
  if (typeof err !== "object" || err === null) return {};
  const e = err as Record<string, unknown>;
  return {
    status: typeof e.status === "number" ? e.status : undefined,
    code: typeof e.code === "string" ? e.code : undefined,
    message: typeof e.message === "string" ? e.message : undefined,
  };
}

/** Decide qué hacer ante un error de envío: reintentar, descartar el dato, detener o ignorar. */
export function classifyError(err: unknown, channel: Channel): ErrorDecision {
  const e = asErrorLike(err);
  const status = e.status ?? 0;
  const code = e.code ?? (status >= 500 ? "internal" : "");
  if (code === "aborted") return { kind: "ignore" };
  if (code === "unauthorized" || status === 401) {
    return { kind: "fatal", stop: "invalid_token", message: STOP_MESSAGES.invalid_token };
  }
  if (code === "conflict" || status === 409) {
    return { kind: "fatal", stop: "aborted", message: STOP_MESSAGES.aborted };
  }
  if (code === "not_found" || status === 404) {
    return { kind: "fatal", stop: "not_found", message: STOP_MESSAGES.not_found };
  }
  if (code === "network") {
    return { kind: "retry", message: "Sin conexión con el puesto de mando. Revisa la señal del teléfono." };
  }
  if (code === "timeout") {
    return { kind: "retry", message: "El puesto de mando tardó demasiado en responder." };
  }
  if (code === "rate_limited" || status === 429) {
    return { kind: "retry", message: "El servidor pidió bajar el ritmo de envío." };
  }
  if (code === "too_large" || status === 413) {
    return { kind: "drop", message: "Un cuadro pesaba demasiado y se descartó." };
  }
  if (code === "invalid" || status === 400) {
    const detail = e.message ? ` (${e.message})` : "";
    return channel === "telemetry"
      ? { kind: "drop", message: `El servidor rechazó datos de telemetría y se descartaron${detail}.` }
      : { kind: "drop", message: `El servidor rechazó un cuadro y se descartó${detail}.` };
  }
  if (code === "forbidden" || status === 403) {
    return { kind: "fatal", stop: "invalid_token", message: STOP_MESSAGES.invalid_token };
  }
  // 5xx, respuesta inesperada o cualquier otro: transitorio.
  return { kind: "retry", message: "El servidor tuvo un problema." };
}

/** Espera antes del intento n (1 = primer reintento): 1 s, 2 s, 4 s … hasta 30 s, ±20 % según `rnd`. */
export function backoffDelay(failures: number, rnd = 0.5): number {
  const n = Math.max(1, Math.floor(failures));
  const raw = Math.min(SENSOR_TIMING.retryMaxMs, SENSOR_TIMING.retryBaseMs * 2 ** (n - 1));
  const jitter = 0.8 + 0.4 * Math.min(1, Math.max(0, rnd));
  return Math.round(Math.min(SENSOR_TIMING.retryMaxMs, raw * jitter));
}

/** Mensaje para un fallo de `getUserMedia`. */
export function cameraErrorMessage(err: unknown, secureContext: boolean): string {
  if (!secureContext) return INSECURE_MESSAGE;
  const name = typeof err === "object" && err !== null ? (err as { name?: unknown }).name : undefined;
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return "Bloqueaste el acceso a la cámara. Actívalo en los ajustes del navegador para este sitio y vuelve a intentarlo.";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return "No encontramos una cámara disponible en este teléfono.";
    case "NotReadableError":
    case "TrackStartError":
      return "Otra aplicación está usando la cámara. Ciérrala y vuelve a intentarlo.";
    case "SecurityError":
      return INSECURE_MESSAGE;
    case "AbortError":
      return "La cámara no alcanzó a encenderse. Vuelve a intentarlo.";
    case "unsupported":
      return "Este navegador no permite usar la cámara. Prueba con Chrome o Safari actualizados.";
    default:
      return "No pudimos encender la cámara. Vuelve a intentarlo.";
  }
}

export const INSECURE_MESSAGE =
  "Este modo necesita una conexión segura (https://). Por http el navegador bloquea la cámara, el GPS y la brújula. Abre el enlace que muestra el puesto de mando, que empieza con https://.";

/* ───────────── Sensores → datos ───────────── */

export interface GpsFix {
  lat: number;
  lng: number;
  accuracy_m: number;
  alt_m: number | null;
  speed_ms: number | null;
  /** Rumbo de desplazamiento según el GPS (solo en movimiento). */
  course_deg: number | null;
  /** Instante local (ms) en que llegó la lectura. */
  at: number;
}

export interface CompassReading {
  deg: number;
  at: number;
}

export type HeadingSource = "compass" | "gps" | "last" | null;

export interface HeadingInfo {
  deg: number | null;
  source: HeadingSource;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const finiteOrNull = (v: number | null | undefined): number | null =>
  v === null || v === undefined || !Number.isFinite(v) ? null : v;
const normDeg = (d: number) => {
  const r = d % 360;
  return r < 0 ? r + 360 : r;
};

/** Rumbo a informar: brújula reciente → rumbo de desplazamiento GPS → último conocido → null. */
export function resolveHeading(
  compass: CompassReading | null,
  fix: GpsFix | null,
  last: number | null,
  now: number,
): HeadingInfo {
  if (compass && now - compass.at <= SENSOR_TIMING.compassStaleMs) return { deg: normDeg(compass.deg), source: "compass" };
  if (
    fix &&
    fix.course_deg !== null &&
    fix.speed_ms !== null &&
    fix.speed_ms >= SENSOR_TIMING.gpsCourseMinSpeedMs &&
    now - fix.at <= SENSOR_TIMING.gpsStaleMs
  ) {
    return { deg: normDeg(fix.course_deg), source: "gps" };
  }
  if (last !== null && Number.isFinite(last)) return { deg: normDeg(last), source: "last" };
  return { deg: null, source: null };
}

export function isFixFresh(fix: GpsFix | null, now: number): fix is GpsFix {
  return fix !== null && now - fix.at <= SENSOR_TIMING.gpsStaleMs;
}

export type GpsState = "waiting" | "ok" | "stale" | "error";

/** Estado del GPS para la interfaz: "SIN GPS" = waiting, stale o error. */
export function gpsState(fix: GpsFix | null, error: string | null, now: number): GpsState {
  if (isFixFresh(fix, now)) return "ok";
  if (error) return "error";
  return fix ? "stale" : "waiting";
}

/**
 * Punto de telemetría con valores dentro de los rangos del servidor.
 * Sin posición reciente → null (no se informa una posición vieja como actual), salvo `allowStale`.
 * El rumbo es obligatorio en el contrato: si se desconoce se envía 0.
 */
export function buildTelemetryPoint(
  fix: GpsFix | null,
  heading: number | null,
  batteryPct: number | null,
  now: number,
  opts: { allowStale?: boolean } = {},
): TelemetryPointInput | null {
  if (!fix) return null;
  if (!opts.allowStale && !isFixFresh(fix, now)) return null;
  const speed = finiteOrNull(fix.speed_ms);
  const battery = finiteOrNull(batteryPct);
  return {
    at: new Date(opts.allowStale ? now : fix.at).toISOString(),
    lat: fix.lat,
    lng: fix.lng,
    alt_m: clamp(finiteOrNull(fix.alt_m) ?? 0, -100, 1000),
    heading_deg: heading === null || !Number.isFinite(heading) ? 0 : clamp(normDeg(heading), 0, 360),
    speed_ms: speed === null ? null : clamp(speed, 0, 100),
    battery_pct: battery === null ? null : clamp(Math.round(battery), 0, 100),
  };
}

export interface FrameMeta {
  /** null = se omite (el servidor usa la última telemetría). */
  lat: number | null;
  lng: number | null;
  alt: number | null;
  heading: number | null;
  t: string;
}

/** Metadatos de un cuadro: usa la última posición conocida aunque sea vieja (o ninguna). */
export function buildFrameMeta(fix: GpsFix | null, heading: number | null, capturedAt: number): FrameMeta {
  const alt = fix ? finiteOrNull(fix.alt_m) : null;
  return {
    lat: fix ? fix.lat : null,
    lng: fix ? fix.lng : null,
    alt: alt === null ? null : clamp(alt, -100, 1000),
    heading: heading === null || !Number.isFinite(heading) ? null : normDeg(heading),
    t: new Date(capturedAt).toISOString(),
  };
}

/* ───────────── Estado del ciclo ───────────── */

export type SessionPhase = "idle" | "running" | "stopping" | "stopped";

export interface ChannelState {
  /** Instante (ms) desde el cual se puede volver a enviar. */
  nextAt: number;
  /** Fallos transitorios seguidos (0 = sin reintentos en curso). */
  failures: number;
  lastOkAt: number | null;
  /** Último error transitorio mientras se reintenta. */
  error: string | null;
}

export interface StopInfo {
  code: StopCode;
  tone: "ok" | "warning" | "critical";
  message: string;
}

export interface SessionState {
  phase: SessionPhase;
  inFlight: Channel | null;
  /** Inicio del envío en curso (para fijar el siguiente según el ritmo). */
  inFlightSince: number | null;
  /** Puntos incluidos en el envío de telemetría en curso. */
  inFlightPoints: number;
  telemetry: ChannelState;
  frame: ChannelState;
  pending: TelemetryPointInput[];
  droppedPoints: number;
  pointsSent: number;
  telemetrySends: number;
  framesSent: number;
  /** Cuadros en el lote abierto (0..BATCH_SIZE-1). */
  batchFrames: number;
  batchesClosed: number;
  /** Cuadros enviados desde el último cierre de lote: si > 0, al detener se envía uno con flush. */
  framesSinceFlush: number;
  mediaId: string | null;
  command: MissionCommand;
  /** Sube cada vez que la orden cambia a recall/abort: la interfaz vibra una vez por cambio. */
  commandSeq: number;
  missionStatus: MissionStatus | null;
  /** Último estado aceptado por el servidor tras informarlo. */
  reportedStatus: ReportableStatus | null;
  /** Último dato descartado (no se reintenta). */
  notice: string | null;
  stop: StopInfo | null;
}

const channel = (nextAt: number): ChannelState => ({ nextAt, failures: 0, lastOkAt: null, error: null });

export function createSession(): SessionState {
  return {
    phase: "idle",
    inFlight: null,
    inFlightSince: null,
    inFlightPoints: 0,
    telemetry: channel(0),
    frame: channel(0),
    pending: [],
    droppedPoints: 0,
    pointsSent: 0,
    telemetrySends: 0,
    framesSent: 0,
    batchFrames: 0,
    batchesClosed: 0,
    framesSinceFlush: 0,
    mediaId: null,
    command: "continue",
    commandSeq: 0,
    missionStatus: null,
    reportedStatus: null,
    notice: null,
    stop: null,
  };
}

export function startSession(s: SessionState, now: number): SessionState {
  if (s.phase === "running" || s.phase === "stopping") return s;
  return {
    ...createSession(),
    // Conserva lo acumulado si se reanuda tras un error de cámara/GPS (no tras un cierre del servidor).
    pointsSent: s.pointsSent,
    telemetrySends: s.telemetrySends,
    framesSent: s.framesSent,
    batchesClosed: s.batchesClosed,
    phase: "running",
    telemetry: channel(now),
    frame: channel(now + SENSOR_TIMING.firstFrameDelayMs),
  };
}

/** Agrega un punto a la cola; si se llena, descarta los más antiguos que no van en el envío en curso. */
export function addPoint(s: SessionState, p: TelemetryPointInput): SessionState {
  if (s.phase !== "running") return s;
  const pending = [...s.pending, p];
  const overflow = pending.length - SENSOR_TIMING.maxPendingPoints;
  if (overflow <= 0) return { ...s, pending };
  // Los primeros `inFlightPoints` van en el envío en curso: no se tocan.
  const k = s.inFlightPoints;
  return {
    ...s,
    pending: [...pending.slice(0, k), ...pending.slice(k + overflow)],
    droppedPoints: s.droppedPoints + overflow,
  };
}

export type Job = { type: "send"; channel: Channel } | { type: "wait"; ms: number } | { type: "none" };

/**
 * Próxima acción mientras el ciclo corre. Nunca dos envíos a la vez: con uno en curso → "none".
 * Si ambos canales vencen, va primero el que lleva más tiempo esperando (empate: telemetría).
 */
export function nextJob(s: SessionState, now: number, opts: { cameraReady: boolean }): Job {
  if (s.phase !== "running" || s.inFlight !== null) return { type: "none" };
  const candidates: { channel: Channel; at: number }[] = [];
  if (s.pending.length > 0) candidates.push({ channel: "telemetry", at: s.telemetry.nextAt });
  if (opts.cameraReady) candidates.push({ channel: "frame", at: s.frame.nextAt });
  if (candidates.length === 0) return { type: "wait", ms: 1000 };
  candidates.sort((a, b) => a.at - b.at || (a.channel === "telemetry" ? -1 : 1));
  const first = candidates[0];
  if (first.at <= now) return { type: "send", channel: first.channel };
  return { type: "wait", ms: Math.min(1000, first.at - now) };
}

/** Estado que corresponde informar según la orden vigente (undefined = no cambia). */
export function statusToReport(s: SessionState): ReportableStatus | undefined {
  let desired: ReportableStatus;
  if (s.command === "recall") desired = "returning";
  else if (s.command === "abort") desired = s.reportedStatus ?? "on_station";
  else desired = "on_station";
  return desired === s.reportedStatus ? undefined : desired;
}

export function telemetryBody(s: SessionState): TelemetryInput {
  const points = s.pending.slice(0, SENSOR_TIMING.maxPendingPoints);
  const status = statusToReport(s);
  return status ? { points, status } : { points };
}

export function beginSend(s: SessionState, ch: Channel, now: number, points = 0): SessionState {
  return { ...s, inFlight: ch, inFlightSince: now, inFlightPoints: ch === "telemetry" ? points : 0 };
}

function withCommand(s: SessionState, command: MissionCommand): SessionState {
  if (command === s.command) return s;
  return { ...s, command, commandSeq: command === "continue" ? s.commandSeq : s.commandSeq + 1 };
}

function endedStop(status: MissionStatus): StopInfo | null {
  if (status === "landed") return { code: "ended_landed", tone: "warning", message: STOP_MESSAGES.ended_landed };
  if (status === "aborted") return { code: "ended_aborted", tone: "critical", message: STOP_MESSAGES.ended_aborted };
  return null;
}

const REPORTABLE: readonly MissionStatus[] = ["launching", "en_route", "on_station", "returning", "landed", "aborted"];

export function telemetrySucceeded(s: SessionState, res: TelemetryResponse, now: number): SessionState {
  const n = s.inFlightPoints;
  const since = s.inFlightSince ?? now;
  let next: SessionState = {
    ...s,
    inFlight: null,
    inFlightSince: null,
    inFlightPoints: 0,
    pending: s.pending.slice(n),
    pointsSent: s.pointsSent + n,
    telemetrySends: s.telemetrySends + 1,
    missionStatus: res.status,
    reportedStatus: REPORTABLE.includes(res.status) ? (res.status as ReportableStatus) : s.reportedStatus,
    telemetry: { nextAt: since + SENSOR_TIMING.telemetryEveryMs, failures: 0, lastOkAt: now, error: null },
  };
  next = withCommand(next, res.command);
  const ended = s.phase === "running" ? endedStop(res.status) : null;
  if (ended) next = { ...next, phase: "stopped", stop: ended };
  return next;
}

export function frameSucceeded(s: SessionState, res: DroneFrameResponse, now: number): SessionState {
  const since = s.inFlightSince ?? now;
  let next: SessionState = {
    ...s,
    inFlight: null,
    inFlightSince: null,
    framesSent: s.framesSent + 1,
    mediaId: res.media_id,
    batchFrames: res.flushed ? 0 : res.frame_idx + 1,
    batchesClosed: res.flushed ? s.batchesClosed + 1 : s.batchesClosed,
    framesSinceFlush: res.flushed ? 0 : s.framesSinceFlush + 1,
    frame: { nextAt: since + SENSOR_TIMING.frameEveryMs, failures: 0, lastOkAt: now, error: null },
  };
  next = withCommand(next, res.command);
  return next;
}

function fatalStop(s: SessionState, code: StopCode, message: string): SessionState {
  return {
    ...s,
    phase: "stopped",
    inFlight: null,
    inFlightSince: null,
    inFlightPoints: 0,
    stop: { code, tone: "critical", message },
  };
}

export function sendFailed(s: SessionState, ch: Channel, err: unknown, now: number, rnd = 0.5): SessionState {
  const d = classifyError(err, ch);
  const base: SessionState = { ...s, inFlight: null, inFlightSince: null, inFlightPoints: 0 };
  const state = s[ch];
  switch (d.kind) {
    case "ignore":
      return base;
    case "fatal":
      return fatalStop(s, d.stop, d.message);
    case "drop": {
      const every = ch === "telemetry" ? SENSOR_TIMING.telemetryEveryMs : SENSOR_TIMING.frameEveryMs;
      const dropped: SessionState = {
        ...base,
        notice: d.message,
        [ch]: { ...state, failures: 0, error: null, nextAt: now + every },
      };
      return ch === "telemetry"
        ? { ...dropped, pending: s.pending.slice(s.inFlightPoints), droppedPoints: s.droppedPoints + s.inFlightPoints }
        : dropped;
    }
    case "retry": {
      const failures = state.failures + 1;
      return { ...base, [ch]: { ...state, failures, error: d.message, nextAt: now + backoffDelay(failures, rnd) } };
    }
  }
}

/** La cámara aún no entrega imagen (o falló la codificación): se vuelve a intentar pronto, sin enviar nada. */
export function captureFailed(s: SessionState, message: string, now: number): SessionState {
  return {
    ...s,
    inFlight: s.inFlight === "frame" ? null : s.inFlight,
    inFlightSince: s.inFlight === "frame" ? null : s.inFlightSince,
    notice: message,
    frame: { ...s.frame, nextAt: now + SENSOR_TIMING.captureRetryMs },
  };
}

/** Pide detener: si hay un envío en curso, se espera a que termine (sin solapar). */
export function requestStop(s: SessionState): SessionState {
  if (s.phase !== "running") return s;
  return { ...s, phase: "stopping" };
}

/** Lo que falta enviar al detener por decisión de la persona. */
export function finalPlan(s: SessionState): { flushFrame: boolean; status: ReportableStatus } {
  return { flushFrame: s.framesSinceFlush > 0, status: s.command === "abort" ? "aborted" : "landed" };
}

/** Cuerpo de la telemetría final: lo pendiente más el último punto, con el estado final. */
export function finalTelemetryBody(
  s: SessionState,
  last: TelemetryPointInput | null,
  status: ReportableStatus,
): TelemetryInput | null {
  const points = last ? [...s.pending, last] : [...s.pending];
  if (points.length === 0) return null;
  return { points: points.slice(-SENSOR_TIMING.maxPendingPoints), status };
}

export interface FinalResult {
  status: ReportableStatus;
  /** null = no hacía falta (sin cuadros desde el último cierre). */
  flushOk: boolean | null;
  /** null = no hubo posición para informar. */
  telemetryOk: boolean | null;
  /** Error que detuvo todo durante el cierre (token inválido, misión abortada…). */
  fatal?: { code: StopCode; message: string } | null;
  /** Respuesta del servidor a la telemetría final y cuántos puntos llevaba. */
  response?: TelemetryResponse | null;
  telemetryPoints?: number;
}

/** Cierra la sesión tras los envíos finales y arma el mensaje para la persona. */
export function finishStop(s: SessionState, r: FinalResult): SessionState {
  if (r.fatal) return fatalStop(s, r.fatal.code, r.fatal.message);
  let next: SessionState = {
    ...s,
    phase: "stopped",
    inFlight: null,
    inFlightSince: null,
    inFlightPoints: 0,
  };
  if (r.flushOk) {
    next = {
      ...next,
      framesSinceFlush: 0,
      batchFrames: 0,
      batchesClosed: next.batchesClosed + 1,
      framesSent: next.framesSent + 1,
    };
  }
  if (r.telemetryOk && r.response) {
    next = {
      ...next,
      pending: [],
      pointsSent: next.pointsSent + (r.telemetryPoints ?? 0),
      telemetrySends: next.telemetrySends + 1,
      missionStatus: r.response.status,
      command: r.response.command,
    };
  }
  const what = r.status === "aborted" ? "la misión quedó abortada" : "el dron está en tierra";
  const parts: string[] = [];
  let tone: StopInfo["tone"] = "ok";
  if (r.telemetryOk) {
    parts.push(`Envío detenido. Avisamos al puesto de mando que ${what}.`);
  } else {
    tone = "warning";
    parts.push(
      r.telemetryOk === null
        ? `Envío detenido, pero sin posición GPS no pudimos avisar al puesto de mando que ${what}. Avísalo por radio.`
        : `Envío detenido, pero no pudimos avisar al puesto de mando que ${what}. Avísalo por radio.`,
    );
  }
  if (r.flushOk === true) parts.push("El último lote de cuadros quedó enviado a análisis.");
  if (r.flushOk === false) {
    tone = "warning";
    parts.push("El último lote de cuadros puede no haber llegado completo.");
  }
  return { ...next, stop: { code: "user", tone, message: parts.join(" ") } };
}

/* ───────────── Orden del mando ───────────── */

export interface CommandView {
  word: "RETORNAR" | "ABORTAR";
  tone: "warning" | "critical";
  detail: string;
}

export function commandView(command: MissionCommand): CommandView | null {
  if (command === "recall") {
    return { word: "RETORNAR", tone: "warning", detail: "El puesto de mando ordena volver a la base. Inicia el regreso ahora." };
  }
  if (command === "abort") {
    return {
      word: "ABORTAR",
      tone: "critical",
      detail: "El puesto de mando ordena abortar. Aterriza de inmediato en un lugar seguro y luego toca Detener.",
    };
  }
  return null;
}

/** Patrón de vibración al recibir una orden nueva (null = no vibrar). */
export function vibrationPattern(command: MissionCommand): number[] | null {
  if (command === "abort") return [500, 150, 500, 150, 500];
  if (command === "recall") return [300, 150, 300];
  return null;
}

/** Hay reintentos en curso en algún canal. */
export function isRetrying(s: SessionState): boolean {
  return s.telemetry.failures > 0 || s.frame.failures > 0;
}
