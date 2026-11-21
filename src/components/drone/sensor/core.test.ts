import { test } from "node:test";
import assert from "node:assert/strict";
import type { DroneFrameResponse, TelemetryResponse } from "@/lib/contract";
import {
  BATCH_SIZE,
  SENSOR_TIMING,
  STOP_MESSAGES,
  addPoint,
  backoffDelay,
  beginSend,
  buildFrameMeta,
  buildTelemetryPoint,
  cameraErrorMessage,
  captureFailed,
  classifyError,
  commandView,
  createSession,
  finalPlan,
  finalTelemetryBody,
  finishStop,
  frameSucceeded,
  gpsState,
  isRetrying,
  nextJob,
  requestStop,
  resolveHeading,
  sendFailed,
  startSession,
  statusToReport,
  telemetryBody,
  telemetrySucceeded,
  vibrationPattern,
  type GpsFix,
  type SessionState,
  type TelemetryPointInput,
} from "./core";

const T0 = Date.parse("2026-11-21T15:00:00.000Z");
const cam = { cameraReady: true };
const noCam = { cameraReady: false };

const fix = (over: Partial<GpsFix> = {}): GpsFix => ({
  lat: -33.4569,
  lng: -70.5976,
  accuracy_m: 6,
  alt_m: 612.4,
  speed_ms: 0.4,
  course_deg: null,
  at: T0,
  ...over,
});

const point = (i = 0): TelemetryPointInput => ({
  at: new Date(T0 + i * 2000).toISOString(),
  lat: -33.4569,
  lng: -70.5976,
  alt_m: 40,
  heading_deg: 90,
  speed_ms: null,
  battery_pct: 80,
});

const tRes = (over: Partial<TelemetryResponse> = {}): TelemetryResponse => ({
  ok: true,
  command: "continue",
  status: "on_station",
  ...over,
});

const fRes = (over: Partial<DroneFrameResponse> = {}): DroneFrameResponse => ({
  ok: true,
  media_id: "md1",
  frame_idx: 0,
  flushed: false,
  command: "continue",
  ...over,
});

const err = (status: number, code: string, message = "x") => ({ status, code, message });

function running(now = T0): SessionState {
  return startSession(createSession(), now);
}

/** Envía la telemetría pendiente y aplica la respuesta. */
function sendTelemetry(s: SessionState, now: number, res = tRes()): SessionState {
  const body = telemetryBody(s);
  return telemetrySucceeded(beginSend(s, "telemetry", now, body.points.length), res, now + 100);
}

/* ───────────── Planificación ───────────── */

test("nextJob: sin puntos ni cámara espera; con punto envía telemetría de inmediato", () => {
  let s = running();
  assert.deepEqual(nextJob(s, T0, noCam), { type: "wait", ms: 1000 });
  s = addPoint(s, point());
  assert.deepEqual(nextJob(s, T0, noCam), { type: "send", channel: "telemetry" });
});

test("nextJob: el primer cuadro espera a que la cámara entregue imagen", () => {
  const s = running();
  const j = nextJob(s, T0, cam);
  assert.equal(j.type, "wait");
  assert.deepEqual(nextJob(s, T0 + SENSOR_TIMING.firstFrameDelayMs, cam), { type: "send", channel: "frame" });
});

test("nextJob: nunca solapa envíos", () => {
  let s = addPoint(running(), point());
  s = beginSend(s, "telemetry", T0, 1);
  assert.deepEqual(nextJob(s, T0 + 60_000, cam), { type: "none" });
});

test("nextJob: si ambos vencen, primero el que lleva más esperando; empate → telemetría", () => {
  let s = addPoint(running(), point());
  s = { ...s, telemetry: { ...s.telemetry, nextAt: T0 + 5000 }, frame: { ...s.frame, nextAt: T0 + 4000 } };
  assert.deepEqual(nextJob(s, T0 + 6000, cam), { type: "send", channel: "frame" });
  s = { ...s, frame: { ...s.frame, nextAt: T0 + 5000 } };
  assert.deepEqual(nextJob(s, T0 + 6000, cam), { type: "send", channel: "telemetry" });
});

test("nextJob: fuera de 'running' no hay trabajo", () => {
  assert.deepEqual(nextJob(createSession(), T0, cam), { type: "none" });
  assert.deepEqual(nextJob(requestStop(addPoint(running(), point())), T0, cam), { type: "none" });
});

test("ritmo: telemetría cada 2 s y cuadro cada 5 s desde el inicio de cada envío", () => {
  let s = addPoint(running(), point());
  s = sendTelemetry(s, T0);
  assert.equal(s.telemetry.nextAt, T0 + SENSOR_TIMING.telemetryEveryMs);
  assert.equal(s.pointsSent, 1);
  assert.equal(s.pending.length, 0);
  const t1 = T0 + SENSOR_TIMING.firstFrameDelayMs;
  s = frameSucceeded(beginSend(s, "frame", t1), fRes(), t1 + 800);
  assert.equal(s.frame.nextAt, t1 + SENSOR_TIMING.frameEveryMs);
  assert.equal(s.framesSent, 1);
  assert.equal(s.batchFrames, 1);
  assert.equal(s.framesSinceFlush, 1);
});

/* ───────────── Cola de telemetría ───────────── */

test("addPoint: tope de 60 descarta los más antiguos, sin tocar los que van en vuelo", () => {
  let s = running();
  for (let i = 0; i < 60; i++) s = addPoint(s, point(i));
  s = beginSend(s, "telemetry", T0, 10);
  s = addPoint(s, point(60));
  s = addPoint(s, point(61));
  assert.equal(s.pending.length, 60);
  assert.equal(s.droppedPoints, 2);
  // Los 10 en vuelo siguen al principio; se fueron los índices 10 y 11.
  assert.equal(s.pending[9].at, point(9).at);
  assert.equal(s.pending[10].at, point(12).at);
  assert.equal(s.pending[59].at, point(61).at);
  s = telemetrySucceeded(s, tRes(), T0 + 500);
  assert.equal(s.pending.length, 50);
  assert.equal(s.pointsSent, 10);
});

test("addPoint: los puntos que llegan durante un envío quedan para el siguiente", () => {
  let s = addPoint(running(), point(0));
  s = beginSend(s, "telemetry", T0, telemetryBody(s).points.length);
  s = addPoint(s, point(1));
  s = telemetrySucceeded(s, tRes(), T0 + 300);
  assert.deepEqual(s.pending, [point(1)]);
});

/* ───────────── Estados informados ───────────── */

test("statusToReport: on_station en el primer envío; luego nada mientras no cambie la orden", () => {
  let s = addPoint(running(), point());
  assert.equal(telemetryBody(s).status, "on_station");
  s = sendTelemetry(s, T0);
  s = addPoint(s, point(1));
  assert.equal(telemetryBody(s).status, undefined);
});

test("statusToReport: recall → returning; resume → on_station; abort no inventa un estado", () => {
  let s = sendTelemetry(addPoint(running(), point()), T0, tRes({ command: "recall" }));
  assert.equal(statusToReport(s), "returning");
  s = sendTelemetry(addPoint(s, point(1)), T0 + 2000, tRes({ command: "recall", status: "returning" }));
  assert.equal(statusToReport(s), undefined);
  s = sendTelemetry(addPoint(s, point(2)), T0 + 4000, tRes({ command: "continue", status: "returning" }));
  assert.equal(statusToReport(s), "on_station");
  s = sendTelemetry(addPoint(s, point(3)), T0 + 6000, tRes({ command: "abort", status: "on_station" }));
  assert.equal(statusToReport(s), undefined);
});

/* ───────────── Orden del mando ───────────── */

test("commandSeq sube una vez por cambio a recall/abort (vibrar una vez por cambio)", () => {
  let s = sendTelemetry(addPoint(running(), point()), T0);
  assert.equal(s.commandSeq, 0);
  s = sendTelemetry(addPoint(s, point(1)), T0 + 2000, tRes({ command: "recall" }));
  assert.equal(s.commandSeq, 1);
  s = sendTelemetry(addPoint(s, point(2)), T0 + 4000, tRes({ command: "recall", status: "returning" }));
  assert.equal(s.commandSeq, 1, "la misma orden repetida no vuelve a vibrar");
  s = frameSucceeded(beginSend(s, "frame", T0 + 5000), fRes({ command: "abort" }), T0 + 5500);
  assert.equal(s.command, "abort");
  assert.equal(s.commandSeq, 2);
  s = sendTelemetry(addPoint(s, point(3)), T0 + 6000, tRes({ command: "continue" }));
  assert.equal(s.commandSeq, 2, "volver a continuar no vibra");
  assert.equal(commandView("continue"), null);
  assert.equal(commandView("recall")?.word, "RETORNAR");
  assert.equal(commandView("recall")?.tone, "warning");
  assert.equal(commandView("abort")?.word, "ABORTAR");
  assert.equal(commandView("abort")?.tone, "critical");
  assert.equal(vibrationPattern("continue"), null);
  assert.ok(vibrationPattern("abort")!.length > vibrationPattern("recall")!.length);
});

test("respuesta con misión terminada detiene el ciclo y lo dice", () => {
  const landed = sendTelemetry(addPoint(running(), point()), T0, tRes({ status: "landed" }));
  assert.equal(landed.phase, "stopped");
  assert.equal(landed.stop?.code, "ended_landed");
  assert.equal(landed.stop?.message, STOP_MESSAGES.ended_landed);
  const aborted = sendTelemetry(addPoint(running(), point()), T0, tRes({ status: "aborted", command: "abort" }));
  assert.equal(aborted.phase, "stopped");
  assert.equal(aborted.stop?.code, "ended_aborted");
  assert.equal(aborted.stop?.tone, "critical");
});

/* ───────────── Lotes ───────────── */

test("lote: cuenta cuadros y se reinicia cuando el servidor cierra el lote", () => {
  let s = running();
  for (let i = 0; i < BATCH_SIZE - 1; i++) {
    s = frameSucceeded(beginSend(s, "frame", T0 + i * 5000), fRes({ frame_idx: i }), T0 + i * 5000 + 200);
  }
  assert.equal(s.batchFrames, BATCH_SIZE - 1);
  assert.equal(s.framesSinceFlush, BATCH_SIZE - 1);
  assert.equal(finalPlan(s).flushFrame, true);
  s = frameSucceeded(beginSend(s, "frame", T0 + 30_000), fRes({ frame_idx: BATCH_SIZE - 1, flushed: true }), T0 + 30_200);
  assert.equal(s.batchFrames, 0);
  assert.equal(s.batchesClosed, 1);
  assert.equal(s.framesSinceFlush, 0);
  assert.equal(finalPlan(s).flushFrame, false);
  assert.equal(s.framesSent, BATCH_SIZE);
});

/* ───────────── Errores y reintentos ───────────── */

test("backoffDelay: exponencial con tope de 30 s y variación acotada", () => {
  assert.equal(backoffDelay(1), 1000);
  assert.equal(backoffDelay(2), 2000);
  assert.equal(backoffDelay(3), 4000);
  assert.equal(backoffDelay(10), 30_000);
  assert.equal(backoffDelay(1, 0), 800);
  assert.equal(backoffDelay(1, 1), 1200);
  assert.ok(backoffDelay(50, 1) <= SENSOR_TIMING.retryMaxMs);
  assert.equal(backoffDelay(0), 1000);
});

test("classifyError: traducción a decisiones y mensajes en español", () => {
  assert.deepEqual(classifyError(err(401, "unauthorized"), "telemetry"), {
    kind: "fatal",
    stop: "invalid_token",
    message: STOP_MESSAGES.invalid_token,
  });
  assert.match(STOP_MESSAGES.invalid_token, /Este enlace ya no es válido o el token es incorrecto/);
  assert.equal(classifyError(err(409, "conflict"), "frame").kind, "fatal");
  assert.equal((classifyError(err(409, "conflict"), "frame") as { stop: string }).stop, "aborted");
  assert.equal((classifyError(err(404, "not_found"), "frame") as { stop: string }).stop, "not_found");
  assert.equal(classifyError(err(0, "network"), "telemetry").kind, "retry");
  assert.equal(classifyError({ code: "timeout" }, "frame").kind, "retry");
  assert.equal(classifyError(err(429, "rate_limited"), "frame").kind, "retry");
  assert.equal(classifyError(err(502, "internal"), "frame").kind, "retry");
  assert.equal(classifyError({ status: 503 }, "frame").kind, "retry");
  assert.equal(classifyError(err(413, "too_large"), "frame").kind, "drop");
  const inv = classifyError(err(400, "invalid", "El cuadro debe ser una imagen JPEG."), "frame");
  assert.equal(inv.kind, "drop");
  assert.match((inv as { message: string }).message, /JPEG/);
  assert.equal(classifyError(err(0, "aborted"), "frame").kind, "ignore");
  assert.equal(classifyError(new Error("boom"), "frame").kind, "retry");
  assert.equal(classifyError(null, "telemetry").kind, "retry");
});

test("sendFailed: red caída → reintento con espera creciente; éxito limpia el estado", () => {
  let s = addPoint(running(), point());
  s = sendFailed(beginSend(s, "telemetry", T0, 1), "telemetry", err(0, "network"), T0 + 100);
  assert.equal(s.inFlight, null);
  assert.equal(s.telemetry.failures, 1);
  assert.equal(s.telemetry.nextAt, T0 + 100 + 1000);
  assert.ok(s.telemetry.error);
  assert.equal(isRetrying(s), true);
  assert.equal(s.pending.length, 1, "los puntos se conservan para el reintento");
  assert.deepEqual(nextJob(s, T0 + 500, noCam), { type: "wait", ms: 600 });
  s = sendFailed(beginSend(s, "telemetry", T0 + 1100, 1), "telemetry", err(0, "network"), T0 + 1200);
  assert.equal(s.telemetry.failures, 2);
  assert.equal(s.telemetry.nextAt, T0 + 1200 + 2000);
  s = addPoint(s, point(1));
  s = sendTelemetry(s, T0 + 3200);
  assert.equal(s.telemetry.failures, 0);
  assert.equal(s.telemetry.error, null);
  assert.equal(isRetrying(s), false);
  assert.equal(s.pointsSent, 2);
});

test("sendFailed: 401 y 409 detienen todo con mensaje claro", () => {
  const a = sendFailed(beginSend(addPoint(running(), point()), "telemetry", T0, 1), "telemetry", err(401, "unauthorized"), T0);
  assert.equal(a.phase, "stopped");
  assert.equal(a.stop?.code, "invalid_token");
  assert.equal(a.stop?.tone, "critical");
  const b = sendFailed(beginSend(running(), "frame", T0), "frame", err(409, "conflict"), T0);
  assert.equal(b.phase, "stopped");
  assert.equal(b.stop?.message, STOP_MESSAGES.aborted);
});

test("sendFailed: datos rechazados (400) se descartan sin reintentar", () => {
  let s = addPoint(addPoint(running(), point(0)), point(1));
  s = beginSend(s, "telemetry", T0, 2);
  s = addPoint(s, point(2));
  s = sendFailed(s, "telemetry", err(400, "invalid", "heading fuera de rango"), T0 + 100);
  assert.deepEqual(s.pending, [point(2)]);
  assert.equal(s.droppedPoints, 2);
  assert.equal(s.telemetry.failures, 0);
  assert.match(s.notice ?? "", /heading fuera de rango/);
  const f = sendFailed(beginSend(running(), "frame", T0), "frame", err(413, "too_large"), T0 + 100);
  assert.equal(f.frame.nextAt, T0 + 100 + SENSOR_TIMING.frameEveryMs);
  assert.equal(f.phase, "running");
});

test("sendFailed: cancelación propia no cuenta como fallo", () => {
  const s = sendFailed(beginSend(running(), "frame", T0), "frame", err(0, "aborted"), T0);
  assert.equal(s.inFlight, null);
  assert.equal(s.frame.failures, 0);
});

test("captureFailed: la cámara sin imagen reintenta pronto, sin fallo de red", () => {
  const s = captureFailed(beginSend(running(), "frame", T0), "La cámara aún no entrega imagen.", T0);
  assert.equal(s.inFlight, null);
  assert.equal(s.frame.nextAt, T0 + SENSOR_TIMING.captureRetryMs);
  assert.equal(s.frame.failures, 0);
});

test("cameraErrorMessage: permisos, ausencia, ocupada y http", () => {
  assert.match(cameraErrorMessage({ name: "NotAllowedError" }, true), /Bloqueaste el acceso a la cámara/);
  assert.match(cameraErrorMessage({ name: "NotFoundError" }, true), /No encontramos una cámara/);
  assert.match(cameraErrorMessage({ name: "NotReadableError" }, true), /Otra aplicación/);
  assert.match(cameraErrorMessage({ name: "NotAllowedError" }, false), /https:\/\//);
  assert.match(cameraErrorMessage({ name: "SecurityError" }, true), /https:\/\//);
  assert.match(cameraErrorMessage(new Error("?"), true), /No pudimos encender la cámara/);
});

/* ───────────── Sensores ───────────── */

test("buildTelemetryPoint: rangos del contrato, altura 0 sin dato y sin posición vieja", () => {
  const p = buildTelemetryPoint(fix({ alt_m: null, speed_ms: Number.NaN }), 370, 54.6, T0 + 1000);
  assert.ok(p);
  assert.equal(p.alt_m, 0);
  assert.equal(p.heading_deg, 10);
  assert.equal(p.speed_ms, null);
  assert.equal(p.battery_pct, 55);
  assert.equal(p.at, new Date(T0).toISOString());
  assert.equal(buildTelemetryPoint(fix({ alt_m: 5000, speed_ms: 250 }), null, null, T0)?.alt_m, 1000);
  assert.equal(buildTelemetryPoint(fix({ speed_ms: 250 }), null, null, T0)?.speed_ms, 100);
  assert.equal(buildTelemetryPoint(fix(), null, null, T0)?.heading_deg, 0);
  assert.equal(buildTelemetryPoint(fix(), -90, null, T0)?.heading_deg, 270);
  assert.equal(buildTelemetryPoint(null, 0, null, T0), null);
  assert.equal(buildTelemetryPoint(fix(), 0, null, T0 + SENSOR_TIMING.gpsStaleMs + 1), null);
  const stale = buildTelemetryPoint(fix(), 0, null, T0 + 60_000, { allowStale: true });
  assert.equal(stale?.at, new Date(T0 + 60_000).toISOString());
});

test("gpsState y buildFrameMeta: SIN GPS conserva la última posición o la omite", () => {
  assert.equal(gpsState(null, null, T0), "waiting");
  assert.equal(gpsState(fix(), null, T0 + 1000), "ok");
  assert.equal(gpsState(fix(), null, T0 + SENSOR_TIMING.gpsStaleMs + 1), "stale");
  assert.equal(gpsState(null, "Bloqueaste el acceso", T0), "error");
  assert.equal(gpsState(fix(), "Bloqueaste el acceso", T0), "ok");
  const m = buildFrameMeta(fix({ at: T0 - 120_000 }), 45, T0);
  assert.equal(m.lat, -33.4569);
  assert.equal(m.alt, 612.4);
  assert.equal(m.heading, 45);
  assert.equal(m.t, new Date(T0).toISOString());
  const none = buildFrameMeta(null, null, T0);
  assert.equal(none.lat, null);
  assert.equal(none.lng, null);
  assert.equal(none.heading, null);
});

test("resolveHeading: brújula → rumbo GPS en movimiento → último conocido", () => {
  assert.deepEqual(resolveHeading({ deg: 100, at: T0 }, fix(), null, T0 + 1000), { deg: 100, source: "compass" });
  const moving = fix({ speed_ms: 6, course_deg: 200 });
  assert.deepEqual(resolveHeading({ deg: 100, at: T0 - 10_000 }, moving, 100, T0), { deg: 200, source: "gps" });
  assert.deepEqual(resolveHeading(null, fix({ speed_ms: 0.2, course_deg: 200 }), 77, T0), { deg: 77, source: "last" });
  assert.deepEqual(resolveHeading(null, null, null, T0), { deg: null, source: null });
});

/* ───────────── Detener ───────────── */

test("requestStop + finalPlan: espera el envío en curso y decide flush y estado final", () => {
  let s = frameSucceeded(beginSend(running(), "frame", T0), fRes(), T0 + 100);
  s = beginSend(addPoint(s, point()), "telemetry", T0 + 200, 1);
  s = requestStop(s);
  assert.equal(s.phase, "stopping");
  assert.equal(s.inFlight, "telemetry", "el envío en curso sigue hasta terminar");
  assert.deepEqual(nextJob(s, T0 + 10_000, cam), { type: "none" });
  s = telemetrySucceeded(s, tRes(), T0 + 300);
  assert.equal(s.phase, "stopping", "una respuesta normal no reabre el ciclo");
  assert.deepEqual(finalPlan(s), { flushFrame: true, status: "landed" });
  const aborting = { ...s, command: "abort" as const };
  assert.equal(finalPlan(aborting).status, "aborted");
});

test("finalTelemetryBody: pendientes + último punto con estado final (máx. 60)", () => {
  let s = running();
  for (let i = 0; i < 60; i++) s = addPoint(s, point(i));
  const body = finalTelemetryBody(s, point(99), "landed");
  assert.ok(body);
  assert.equal(body.points.length, 60);
  assert.equal(body.points[59].at, point(99).at);
  assert.equal(body.status, "landed");
  assert.equal(finalTelemetryBody(createSession(), null, "landed"), null);
});

test("finishStop: mensajes según lo que alcanzó a llegar", () => {
  const s = requestStop(frameSucceeded(beginSend(running(), "frame", T0), fRes(), T0 + 100));
  const ok = finishStop(s, {
    status: "landed",
    flushOk: true,
    telemetryOk: true,
    response: tRes({ status: "landed" }),
    telemetryPoints: 1,
  });
  assert.equal(ok.phase, "stopped");
  assert.equal(ok.stop?.tone, "ok");
  assert.match(ok.stop?.message ?? "", /el dron está en tierra/);
  assert.equal(ok.batchesClosed, 1);
  assert.equal(ok.framesSent, 2);
  assert.equal(ok.missionStatus, "landed");
  const noGps = finishStop(s, { status: "landed", flushOk: null, telemetryOk: null });
  assert.equal(noGps.stop?.tone, "warning");
  assert.match(noGps.stop?.message ?? "", /sin posición GPS/);
  assert.match(noGps.stop?.message ?? "", /radio/);
  const failed = finishStop(s, { status: "aborted", flushOk: false, telemetryOk: false });
  assert.match(failed.stop?.message ?? "", /la misión quedó abortada/);
  assert.match(failed.stop?.message ?? "", /lote/);
  const fatal = finishStop(s, {
    status: "landed",
    flushOk: false,
    telemetryOk: null,
    fatal: { code: "invalid_token", message: STOP_MESSAGES.invalid_token },
  });
  assert.equal(fatal.stop?.code, "invalid_token");
  assert.equal(fatal.stop?.tone, "critical");
});

test("startSession: no reinicia una sesión en curso", () => {
  const s = addPoint(running(), point());
  assert.equal(startSession(s, T0 + 5000), s);
});
