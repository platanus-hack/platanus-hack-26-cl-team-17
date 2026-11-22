/**
 * Video en vivo con detector YOLO: detector HTTP falso en un puerto libre, store local en una
 * carpeta temporal y sin credencial de IA (el observador responde simulado).
 *   node --import tsx --test src/lib/drone/live-detect.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vigia-live-detect-test-"));
process.env.VIGIA_DATA_DIR = dataDir;
delete process.env.DATABASE_URL;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

const requests: { annotate: boolean; conf: string | null; byte: number }[] = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/health") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, model: "falso", labels: ["persona"] }));
    return;
  }
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const annotate = url.searchParams.get("annotate") === "1";
    requests.push({ annotate, conf: url.searchParams.get("conf"), byte: body[4] });
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        width: 640,
        height: 360,
        ms: 12,
        detections: [{ label: "persona", conf: 0.8, box: [0.1, 0.2, 0.3, 0.9], zone: { h: "izquierda", v: "medio" }, pose: "de_pie" }],
        counts: { persona: 1 },
        ...(annotate ? { annotated_jpeg_b64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64") } : {}),
      }),
    );
  });
});

type Live = typeof import("./live");
let live: Live;
let deps: import("./service").DroneDeps;
let clock = Date.parse("2026-11-21T22:00:00.000Z");
const deferred: (() => Promise<void>)[] = [];

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.VIGIA_DETECTOR_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  live = await import("./live");
  const { createLocalStore } = await import("@/lib/store/local");
  const { createLocalFiles } = await import("@/lib/store/local-files");
  deps = {
    store: createLocalStore(),
    files: createLocalFiles(),
    now: () => clock,
    defer: (t) => void deferred.push(t),
    processMedia: async () => undefined,
    // Doble del observador (sin IA real): resume cuántos cuadros recibió.
    analyzeLive: async (input) => ({
      summary: `${input.frames.length} ${input.frames.length === 1 ? "cuadro" : "cuadros"} del dron ${input.mission.label}`,
      severity: "info",
      changed: false,
      observations: [],
      engine: "claude",
    }),
  };
});
after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function runDeferred() {
  while (deferred.length) await deferred.shift()!();
}

async function newMission() {
  const incident = await deps.store.createIncident({
    type: "structure_fire",
    title: "Prueba detector en vivo",
    address: "Calle de prueba 123",
    lat: -33.4569,
    lng: -70.5987,
    description: "",
    origin: "command",
    verified: true,
  });
  const { createMission } = await import("./service");
  const { CreateMissionInputSchema } = await import("@/lib/domain");
  return (await createMission(deps, incident.id, CreateMissionInputSchema.parse({ mode: "device" }))).mission;
}

const jpeg = (n: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, n & 0xff, 0x00, 0xff, 0xd9]);

test("cada cuadro pasa por YOLO en segundo plano; con una detección en curso se salta el siguiente", async () => {
  const mission = await newMission();
  assert.equal(live.getLiveDetections(mission.id), null);

  const a = await live.pushLiveFrame(deps, mission, jpeg(1));
  clock += 300;
  // La detección del cuadro 1 sigue pendiente: el cuadro 2 no se encola.
  await live.pushLiveFrame(deps, mission, jpeg(2));
  await runDeferred();
  assert.deepEqual(
    requests.filter((r) => !r.annotate).map((r) => r.byte),
    [1],
  );
  assert.equal(requests[0].conf, "0.1");
  const latest = live.getLiveDetections(mission.id);
  assert.ok(latest);
  assert.equal(latest.seq, a.seq, "la detección queda con el seq de su cuadro");
  assert.equal(latest.result.counts.persona, 1);
  assert.equal("annotated_jpeg_b64" in latest.result, false);

  // Ya libre: el próximo cuadro sí pasa.
  clock += 300;
  const c = await live.pushLiveFrame(deps, mission, jpeg(3));
  await runDeferred();
  assert.equal(live.getLiveDetections(mission.id)?.seq, c.seq);
  assert.deepEqual(
    live.listLiveDetectionHistory(mission.id).map((d) => d.seq),
    [a.seq, c.seq],
  );
});

test("historial corto: quedan las últimas 120 (cubren la ventana del observador)", async () => {
  const mission = await newMission();
  for (let i = 0; i < 125; i++) {
    clock += 300;
    await live.pushLiveFrame(deps, mission, jpeg(i));
    await runDeferred();
  }
  const history = live.listLiveDetectionHistory(mission.id);
  assert.equal(history.length, 120);
  assert.ok(history.every((d, i) => i === 0 || d.seq > history[i - 1].seq));
});

test("el observador con detector recibe UN cuadro anotado y cuenta los cuadros que pasaron por YOLO", async () => {
  const mission = await newMission();
  requests.length = 0;
  for (let i = 0; i < 12; i++) {
    clock += 300;
    await live.pushLiveFrame(deps, mission, jpeg(100 + i));
    await runDeferred();
  }
  const { insights } = live.listLiveInsights(mission.id);
  assert.equal(insights.length, 1);
  assert.equal(insights[0].engine, "claude");
  assert.match(insights[0].summary, /1 cuadro/, "con detector la entrada lleva un solo cuadro");
  assert.ok(insights[0].frames >= 9, `cuadros con YOLO en la ventana: ${insights[0].frames}`);
  assert.equal(requests.filter((r) => r.annotate).length, 1, "se pide un solo cuadro anotado");
});
