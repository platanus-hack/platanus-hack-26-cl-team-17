import { test } from "node:test";
import assert from "node:assert/strict";
import type { DroneFrameResponse, TelemetryResponse } from "@/lib/contract";
import type { DroneMission, TelemetryInput } from "@/lib/domain";
import { SensorController, type SensorClock, type SensorInputs, type SensorTransport } from "./controller";
import type { FrameMeta, GpsFix, SessionState } from "./core";

const T0 = Date.parse("2026-11-21T15:00:00.000Z");
const flush = () => new Promise<void>((r) => setImmediate(r));

class ManualClock implements SensorClock {
  t = T0;
  private seq = 0;
  private tasks: { at: number; id: number; fn: () => void }[] = [];
  now() {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number) {
    const id = ++this.seq;
    this.tasks.push({ at: this.t + Math.max(0, ms), id, fn });
    return id;
  }
  clearTimeout(h: unknown) {
    this.tasks = this.tasks.filter((x) => x.id !== h);
  }
  random() {
    return 0.5;
  }
  /** Avanza el reloj ejecutando los temporizadores vencidos y las promesas pendientes. */
  async advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      await flush();
      this.tasks.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.tasks[0];
      if (!next || next.at > end) break;
      this.tasks.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
    await flush();
  }
}

class HttpLikeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function setup(opts: { gps?: boolean } = {}) {
  const clock = new ManualClock();
  const telemetry: TelemetryInput[] = [];
  const frames: { meta: FrameMeta; flush: boolean }[] = [];
  const server = {
    command: "continue" as DroneMission["command"],
    status: "on_station" as DroneMission["status"],
    telemetryError: null as Error | null,
    batch: 0,
  };
  const transport: SensorTransport = {
    async telemetry(body) {
      if (server.telemetryError) throw server.telemetryError;
      telemetry.push(body);
      if (body.status) server.status = body.status;
      return { ok: true, command: server.command, status: server.status } satisfies TelemetryResponse;
    },
    async frame(_blob, meta, flushFrame) {
      frames.push({ meta, flush: flushFrame });
      const idx = server.batch;
      const flushed = flushFrame || idx + 1 >= 6;
      server.batch = flushed ? 0 : idx + 1;
      return { ok: true, media_id: "m1", frame_idx: idx, flushed, command: server.command } satisfies DroneFrameResponse;
    },
  };
  const fix = (): GpsFix | null =>
    opts.gps === false
      ? null
      : { lat: -33.45, lng: -70.6, accuracy_m: 5, alt_m: 12, speed_ms: 0, course_deg: null, at: clock.now() };
  const inputs: SensorInputs = {
    fix,
    compass: () => ({ deg: 90, at: clock.now() }),
    battery: () => 80,
    cameraReady: () => true,
    capture: async () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" }),
  };
  const states: SessionState[] = [];
  const c = new SensorController(transport, inputs, (s) => states.push(s), clock);
  return { clock, c, telemetry, frames, server, states };
}

test("ciclo: telemetría cada 2 s y un cuadro cada 5 s; el estado se informa una vez", async () => {
  const { clock, c, telemetry, frames } = setup();
  c.start();
  await clock.advance(0);
  assert.equal(telemetry.length, 1);
  assert.equal(telemetry[0].status, "on_station");
  assert.equal(telemetry[0].points[0].heading_deg, 90);
  assert.equal(telemetry[0].points[0].battery_pct, 80);
  await clock.advance(30_000);
  assert.ok(telemetry.length >= 15 && telemetry.length <= 16, `telemetría ${telemetry.length}`);
  assert.ok(telemetry.slice(1).every((b) => b.status === undefined));
  // Primer cuadro a los 1,5 s y luego cada 5 s: 1,5 · 6,5 · … · 26,5.
  assert.equal(frames.length, 6);
  assert.ok(frames.every((f) => !f.flush && f.meta.lat === -33.45 && f.meta.heading === 90));
  assert.equal(c.state.batchesClosed, 1);
  assert.equal(c.state.batchFrames, 0);
  c.dispose();
});

test("orden del mando: recall se informa como 'returning'; al detener cierra el lote y avisa 'landed'", async () => {
  const { clock, c, telemetry, frames, server } = setup();
  c.start();
  await clock.advance(8_000);
  server.command = "recall";
  await clock.advance(2_000);
  assert.equal(c.state.command, "recall");
  assert.equal(c.state.commandSeq, 1);
  await clock.advance(2_000);
  assert.equal(telemetry.at(-1)!.status, "returning");
  const framesBefore = frames.length;
  assert.ok(c.state.framesSinceFlush > 0);

  c.stop();
  await clock.advance(1_000);
  assert.equal(frames.length, framesBefore + 1);
  assert.equal(frames.at(-1)!.flush, true);
  assert.equal(telemetry.at(-1)!.status, "landed");
  assert.equal(c.state.phase, "stopped");
  assert.equal(c.state.stop?.code, "user");
  assert.equal(c.state.stop?.tone, "ok");
  // Detenido: no hay más envíos.
  const n = telemetry.length;
  await clock.advance(20_000);
  assert.equal(telemetry.length, n);
});

test("abortar: al detener se informa 'aborted'", async () => {
  const { clock, c, telemetry, server } = setup();
  c.start();
  await clock.advance(3_000);
  server.command = "abort";
  await clock.advance(2_000);
  assert.equal(c.state.command, "abort");
  c.stop();
  await clock.advance(1_000);
  assert.equal(telemetry.at(-1)!.status, "aborted");
  assert.match(c.state.stop!.message, /abortada/);
});

test("token inválido (401) detiene todo con mensaje claro", async () => {
  const { clock, c, server, frames } = setup();
  server.telemetryError = new HttpLikeError(401, "unauthorized");
  c.start();
  await clock.advance(10_000);
  assert.equal(c.state.phase, "stopped");
  assert.equal(c.state.stop?.code, "invalid_token");
  assert.equal(frames.length, 0);
});

test("sin red: reintenta con espera creciente y retoma cuando vuelve", async () => {
  const { clock, c, server, telemetry } = setup();
  server.telemetryError = new HttpLikeError(0, "network");
  c.start();
  await clock.advance(4_000);
  assert.ok(c.state.telemetry.failures >= 2);
  assert.match(c.state.telemetry.error ?? "", /Sin conexión/);
  server.telemetryError = null;
  await clock.advance(10_000);
  assert.equal(c.state.telemetry.failures, 0);
  // Lo acumulado durante el corte sale en un solo envío.
  assert.ok(telemetry[0].points.length >= 3, `puntos ${telemetry[0].points.length}`);
  c.dispose();
});

test("sin GPS: no inventa posición; los cuadros salen sin lat/lng", async () => {
  const { clock, c, telemetry, frames } = setup({ gps: false });
  c.start();
  await clock.advance(7_000);
  assert.equal(telemetry.length, 0);
  assert.ok(frames.length >= 1);
  assert.equal(frames[0].meta.lat, null);
  c.dispose();
});
