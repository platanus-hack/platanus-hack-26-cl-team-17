/**
 * Ciclo del modo sensor: decide con el núcleo puro (./core) qué enviar y cuándo, y ejecuta los envíos
 * con dependencias inyectadas (transporte HTTP, lecturas de sensores y reloj). Sin globals del navegador
 * al importar: se prueba en node con un reloj manual.
 */
import type { DroneFrameResponse, TelemetryResponse } from "@/lib/contract";
import type { TelemetryInput } from "@/lib/domain";
import {
  backoffDelay,
  beginSend,
  buildFrameMeta,
  buildTelemetryPoint,
  captureFailed,
  classifyError,
  createSession,
  finalPlan,
  finalTelemetryBody,
  finishStop,
  frameSucceeded,
  nextJob,
  requestStop,
  resolveHeading,
  SENSOR_TIMING,
  sendFailed,
  startSession,
  telemetryBody,
  telemetrySucceeded,
  addPoint,
  type CompassReading,
  type FinalResult,
  type FrameMeta,
  type GpsFix,
  type SessionState,
  type StopCode,
} from "./core";

export interface SensorTransport {
  telemetry(body: TelemetryInput, signal: AbortSignal): Promise<TelemetryResponse>;
  /** Cuadros a lotes de análisis (quedan guardados en el incidente). Sin él, el ciclo no captura cuadros. */
  frame?(blob: Blob, meta: FrameMeta, flush: boolean, signal: AbortSignal): Promise<DroneFrameResponse>;
}

export interface SensorInputs {
  fix(): GpsFix | null;
  compass(): CompassReading | null;
  battery(): number | null;
  cameraReady(): boolean;
  /** JPEG del cuadro actual de la cámara; lanza si la cámara aún no entrega imagen. */
  capture(): Promise<Blob>;
}

export interface SensorClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  random(): number;
}

export const browserClock: SensorClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  random: () => Math.random(),
};

class TimeoutError extends Error {
  readonly code = "timeout";
  constructor() {
    super("Tiempo de espera agotado.");
    this.name = "TimeoutError";
  }
}

function captureMessage(err: unknown): string {
  const msg = err instanceof Error && err.message ? err.message : "";
  return msg || "La cámara aún no entrega imagen. Reintentamos en un momento.";
}

export class SensorController {
  private s: SessionState = createSession();
  private pumpTimer: unknown = null;
  private sampleTimer: unknown = null;
  private inflight: AbortController | null = null;
  private lastHeading: number | null = null;
  private finishing = false;
  private disposed = false;

  constructor(
    private readonly transport: SensorTransport,
    private readonly inputs: SensorInputs,
    private readonly onState: (s: SessionState) => void,
    private readonly clock: SensorClock = browserClock,
  ) {}

  get state(): SessionState {
    return this.s;
  }

  /** Rumbo a informar ahora (brújula → rumbo GPS → último conocido). */
  heading(now = this.clock.now()): number | null {
    const h = resolveHeading(this.inputs.compass(), this.inputs.fix(), this.lastHeading, now);
    if (h.deg !== null) this.lastHeading = h.deg;
    return h.deg;
  }

  start(): void {
    if (this.disposed || this.s.phase === "running" || this.s.phase === "stopping") return;
    // Tras un cierre del servidor (token inválido, misión terminada) no se reanuda.
    if (this.s.stop && this.s.stop.code !== "user") return;
    this.finishing = false;
    this.commit(startSession(this.s, this.clock.now()));
    this.sample();
    this.pump();
  }

  /** Detiene a pedido de la persona: espera el envío en curso y luego cierra el lote e informa el estado final. */
  stop(): void {
    if (this.s.phase !== "running") return;
    this.commit(requestStop(this.s));
    this.clearSampler();
    this.pump();
  }

  /** Corta todo sin envíos finales (al salir de la página). */
  dispose(): void {
    this.disposed = true;
    this.clearSampler();
    this.clearPump();
    this.inflight?.abort();
    this.inflight = null;
  }

  /* ───────────── Internos ───────────── */

  private commit(next: SessionState): void {
    this.s = next;
    if (!this.disposed) this.onState(next);
  }

  private clearPump(): void {
    if (this.pumpTimer !== null) this.clock.clearTimeout(this.pumpTimer);
    this.pumpTimer = null;
  }

  private clearSampler(): void {
    if (this.sampleTimer !== null) this.clock.clearTimeout(this.sampleTimer);
    this.sampleTimer = null;
  }

  /** Toma un punto de telemetría cada `telemetryEveryMs` mientras el ciclo corre. */
  private sample(): void {
    this.clearSampler();
    if (this.disposed || this.s.phase !== "running") return;
    const now = this.clock.now();
    const point = buildTelemetryPoint(this.inputs.fix(), this.heading(now), this.inputs.battery(), now);
    if (point) {
      const hadNone = this.s.pending.length === 0;
      this.commit(addPoint(this.s, point));
      // Primer punto tras una espera sin GPS: que salga ya, no al próximo despertar.
      if (hadNone && this.s.inFlight === null) this.pump();
    }
    this.sampleTimer = this.clock.setTimeout(() => this.sample(), SENSOR_TIMING.telemetryEveryMs);
  }

  private pump(): void {
    this.clearPump();
    if (this.disposed) return;
    if (this.s.phase === "stopping") {
      if (this.s.inFlight === null) void this.finish();
      return;
    }
    if (this.s.phase !== "running") return;
    const now = this.clock.now();
    const job = nextJob(this.s, now, { cameraReady: this.transport.frame !== undefined && this.inputs.cameraReady() });
    if (job.type === "wait") {
      this.pumpTimer = this.clock.setTimeout(() => this.pump(), job.ms);
      return;
    }
    if (job.type === "none") return;
    if (job.channel === "telemetry") void this.sendTelemetry(now);
    else void this.sendFrame(now);
  }

  private async call<T>(fn: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
    const ctl = new AbortController();
    this.inflight = ctl;
    let timedOut = false;
    const h = this.clock.setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, timeoutMs);
    try {
      return await fn(ctl.signal);
    } catch (err) {
      if (timedOut) throw new TimeoutError();
      throw err;
    } finally {
      this.clock.clearTimeout(h);
      if (this.inflight === ctl) this.inflight = null;
    }
  }

  private async sendTelemetry(now: number): Promise<void> {
    const body = telemetryBody(this.s);
    this.commit(beginSend(this.s, "telemetry", now, body.points.length));
    try {
      const res = await this.call((signal) => this.transport.telemetry(body, signal), SENSOR_TIMING.telemetryTimeoutMs);
      if (this.disposed) return;
      this.commit(telemetrySucceeded(this.s, res, this.clock.now()));
    } catch (err) {
      if (this.disposed) return;
      this.commit(sendFailed(this.s, "telemetry", err, this.clock.now(), this.clock.random()));
    }
    this.afterSend();
  }

  private async sendFrame(now: number): Promise<void> {
    const send = this.transport.frame?.bind(this.transport);
    if (!send) return; // pump() no agenda cuadros sin este canal
    this.commit(beginSend(this.s, "frame", now));
    const capturedAt = this.clock.now();
    let blob: Blob;
    try {
      blob = await this.inputs.capture();
    } catch (err) {
      if (this.disposed) return;
      this.commit(captureFailed(this.s, captureMessage(err), this.clock.now()));
      this.afterSend();
      return;
    }
    if (this.disposed) return;
    const meta = buildFrameMeta(this.inputs.fix(), this.heading(capturedAt), capturedAt);
    try {
      const res = await this.call((signal) => send(blob, meta, false, signal), SENSOR_TIMING.frameTimeoutMs);
      if (this.disposed) return;
      this.commit(frameSucceeded(this.s, res, this.clock.now()));
    } catch (err) {
      if (this.disposed) return;
      this.commit(sendFailed(this.s, "frame", err, this.clock.now(), this.clock.random()));
    }
    this.afterSend();
  }

  private afterSend(): void {
    if (this.s.phase === "stopped") {
      this.clearSampler();
      this.clearPump();
      return;
    }
    this.pump();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.clock.setTimeout(resolve, ms);
    });
  }

  /** Envíos finales: cuadro con flush (si el lote quedó abierto) y telemetría con el estado final. */
  private async finish(): Promise<void> {
    if (this.finishing || this.disposed) return;
    this.finishing = true;
    const plan = finalPlan(this.s);
    let fatal: { code: StopCode; message: string } | null = null;
    let flushOk: boolean | null = null;

    const send = this.transport.frame?.bind(this.transport);
    if (plan.flushFrame && send) {
      flushOk = false;
      for (let attempt = 1; attempt <= SENSOR_TIMING.finalAttempts && !this.disposed; attempt++) {
        if (!this.inputs.cameraReady()) break;
        try {
          const capturedAt = this.clock.now();
          const blob = await this.inputs.capture();
          const meta = buildFrameMeta(this.inputs.fix(), this.heading(capturedAt), capturedAt);
          await this.call((signal) => send(blob, meta, true, signal), SENSOR_TIMING.frameTimeoutMs);
          flushOk = true;
          break;
        } catch (err) {
          const d = classifyError(err, "frame");
          if (d.kind === "fatal") {
            fatal = { code: d.stop, message: d.message };
            break;
          }
          if (d.kind === "drop" || d.kind === "ignore") break;
          if (attempt < SENSOR_TIMING.finalAttempts) await this.sleep(backoffDelay(attempt, this.clock.random()));
        }
      }
    }

    let telemetryOk: boolean | null = null;
    let response: TelemetryResponse | null = null;
    let telemetryPoints = 0;
    if (!fatal && !this.disposed) {
      const now = this.clock.now();
      const last = buildTelemetryPoint(this.inputs.fix(), this.heading(now), this.inputs.battery(), now, { allowStale: true });
      const body = finalTelemetryBody(this.s, last, plan.status);
      if (body) {
        telemetryOk = false;
        telemetryPoints = body.points.length;
        for (let attempt = 1; attempt <= SENSOR_TIMING.finalAttempts && !this.disposed; attempt++) {
          try {
            response = await this.call((signal) => this.transport.telemetry(body, signal), SENSOR_TIMING.telemetryTimeoutMs);
            telemetryOk = true;
            break;
          } catch (err) {
            const d = classifyError(err, "telemetry");
            if (d.kind === "fatal") {
              fatal = { code: d.stop, message: d.message };
              break;
            }
            if (d.kind === "drop" || d.kind === "ignore") break;
            if (attempt < SENSOR_TIMING.finalAttempts) await this.sleep(backoffDelay(attempt, this.clock.random()));
          }
        }
      }
    }
    if (this.disposed) return;
    const result: FinalResult = { status: plan.status, flushOk, telemetryOk, fatal, response, telemetryPoints };
    this.commit(finishStop(this.s, result));
    this.clearPump();
  }
}
