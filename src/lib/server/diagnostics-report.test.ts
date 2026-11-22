/**
 * Piezas puras del diagnóstico de la vista técnica.
 *   node --import tsx --test src/lib/server/diagnostics-report.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ZelloBridgeStatus, ZelloStatusResponse } from "@/lib/contract";
import type { CommEntry, Media } from "@/lib/domain";
import { emptyVigiaState, type VigiaState, type VigiaUtterance } from "@/lib/vigia/types";
import {
  blockedFromLog,
  bridgeCanSpeak,
  buildOutbox,
  engineView,
  mediaQueue,
  unreadComms,
  unseenMedia,
} from "./diagnostics-report";

const T0 = Date.parse("2026-11-21T18:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const BRIDGE: ZelloBridgeStatus = {
  connected: true,
  channel: "demo-platanus",
  users_online: 3,
  listen_only: false,
  error: null,
  incident_codes: ["VG-AB12"],
  last_transmission: null,
  last_spoken: null,
  sent_at: iso(T0),
};

function zello(over: Partial<ZelloBridgeStatus> | null, stale = false): ZelloStatusResponse {
  return over === null ? { status: null, received_at: null, stale: true } : { status: { ...BRIDGE, ...over }, received_at: iso(T0), stale };
}

function utt(seq: number, atMs: number, over: Partial<VigiaUtterance> = {}): VigiaUtterance {
  return {
    id: `u${seq}`,
    seq,
    incident_id: "i1",
    at: iso(atMs),
    text: `Mensaje ${seq}`,
    priority: "resto",
    kind: "alerta",
    speak: true,
    evidence: [],
    confidence: null,
    engine: "claude",
    rules: [],
    claves: null,
    reply_to: null,
    ...over,
  };
}

function state(utterances: VigiaUtterance[], over: Partial<VigiaState> = {}): VigiaState {
  return { ...emptyVigiaState("i1", iso(T0)), utterances, seq: utterances.length, ...over };
}

const TURNS = { last: null, thought: null };

test("buildOutbox: en cola, dicho, salió y sin puente", () => {
  const s = state([
    utt(1, T0 - 120_000, { text: "OBAC, Vigía: veo humo negro en el lado C." }),
    utt(2, T0 - 60_000),
    utt(3, T0 - 10_000),
  ]);
  const z = zello({ last_spoken: { at: iso(T0 - 115_000), text: "OBAC, Vigía: veo humo negro en el lado C." } });
  const o = buildOutbox({ state: s, zello: z, nowMs: T0, agentEnabled: true, unreadComms: 0, unseenMedia: 0, turns: TURNS });
  const byseq = new Map(o.recent.map((u) => [u.seq, u.state]));
  assert.equal(byseq.get(1), "dicho");
  assert.equal(byseq.get(2), "salio");
  assert.equal(byseq.get(3), "en_cola");
  assert.deepEqual(o.waiting.map((u) => u.seq), [3]);
  assert.equal(o.recent[0].seq, 3, "más recientes primero");
  assert.equal(o.voice_interval_ms, 20_000);

  // Sin puente (o en solo escucha) lo hablado no lo dice nadie.
  for (const z2 of [zello(null), zello({ listen_only: true }), zello({}, true), zello({ stopped: true })]) {
    assert.equal(bridgeCanSpeak(z2), false);
    const o2 = buildOutbox({ state: s, zello: z2, nowMs: T0, agentEnabled: true, unreadComms: 0, unseenMedia: 0, turns: TURNS });
    assert.equal(o2.recent.find((u) => u.seq === 3)?.state, "sin_puente");
    assert.equal(o2.waiting.length, 0);
  }
});

test("buildOutbox: por qué quedó solo en pantalla", () => {
  const s = state([
    utt(1, T0 - 30_000),
    utt(2, T0 - 25_000, { speak: false }),
    utt(3, T0 - 24_000, { speak: false, kind: "propuesta" }),
    utt(4, T0 - 23_000, { speak: false, kind: "respuesta" }),
    utt(5, T0 - 1_000, { speak: false }),
  ]);
  const o = buildOutbox({ state: s, zello: zello({}), nowMs: T0, agentEnabled: true, unreadComms: 0, unseenMedia: 0, turns: TURNS });
  const reason = new Map(o.recent.map((u) => [u.seq, u.screen_reason]));
  assert.equal(reason.get(1), null);
  assert.equal(reason.get(2), "limite_20s");
  assert.equal(reason.get(3), "propuesta");
  assert.equal(reason.get(4), "pantalla", "una respuesta no espera los 20 s");
  assert.equal(reason.get(5), "pantalla", "más de 20 s después del último hablado");
  const silenced = buildOutbox({ state: { ...s, silenced: true }, zello: zello({}), nowMs: T0, agentEnabled: true, unreadComms: 0, unseenMedia: 0, turns: TURNS });
  assert.equal(silenced.recent.find((u) => u.seq === 2)?.screen_reason, "silencio");
});

test("blockedFromLog lee los mensajes bloqueados por las reglas de la bitácora", () => {
  const log = [
    { id: "l1", at: iso(T0 - 5000), what: "Mensaje bloqueado por las reglas: «B-3, entren por el lado C»", why: "Regla: orden_a_unidad, decision_tactica", evidence: [] },
    { id: "l2", at: iso(T0 - 4000), what: "Pedido de video el lado C", why: "falta el lado C", evidence: [] },
    { id: "l3", at: iso(T0 - 3000), what: "Mensaje bloqueado por las reglas: «Evacuar el edificio.»", why: "Regla: orden", evidence: [] },
  ];
  const b = blockedFromLog(log);
  assert.equal(b.length, 2);
  assert.deepEqual(b[0], { at: iso(T0 - 3000), text: "Evacuar el edificio.", reasons: ["orden"] });
  assert.deepEqual(b[1].reasons, ["orden_a_unidad", "decision_tactica"]);
});

test("mediaQueue cuenta la cola y no toma el lote abierto del dron como atraso", () => {
  const m = (label: string, status: Media["status"], created: number, over: Partial<Media> = {}) =>
    ({ id: label, label, status, created_at: iso(created), analyzed_at: null, analysis_engine: null, error: null, source: "citizen", ...over }) as Media;
  const q = mediaQueue([
    m("M1", "analyzed", T0 - 600_000, { analyzed_at: iso(T0 - 500_000), analysis_engine: "claude" }),
    m("M2", "uploaded", T0 - 300_000),
    m("M3", "analyzing", T0 - 200_000),
    m("M4", "failed", T0 - 100_000, { error: "Sin fotogramas" }),
    m("D1", "uploading", T0 - 900_000, { source: "drone" }),
  ]);
  assert.equal(q.total, 5);
  assert.equal(q.queued, 1);
  assert.equal(q.analyzing, 1);
  assert.equal(q.uploading, 1);
  assert.equal(q.failed, 1);
  assert.deepEqual(q.oldest_pending, { label: "M2", since: iso(T0 - 300_000), status: "uploaded" });
  assert.equal(q.last_analyzed?.label, "M1");
  assert.deepEqual(q.last_failed, { label: "M4", error: "Sin fotogramas" });
});

test("lo que Vigía aún no mira: radio sin su propia voz ni vacías, y videos con estado nuevo", () => {
  const c = (seq: number, speaker: string, text: string, source: CommEntry["source"] = "zello") => ({ seq, speaker, text, source }) as CommEntry;
  const comms = [c(1, "B-3", "en 6-3"), c(2, "Vigía", "OBAC, Vigía: veo humo"), c(3, "B-4", ""), c(4, "Central", "6-0 en ruta", "manual")];
  assert.equal(unreadComms(comms, 0), 2);
  assert.equal(unreadComms(comms, 1), 1);
  assert.equal(unseenMedia([{ id: "a", status: "analyzed" }, { id: "b", status: "uploaded" }], { a: "analyzing", b: "uploaded" }), 1);
});

test("engineView no envía credenciales, solo si existen", () => {
  const prev = { ...process.env };
  try {
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-secreto";
    const e = engineView();
    assert.equal(e.ai, "claude");
    assert.equal(e.has_credential, true);
    assert.doesNotMatch(JSON.stringify(e), /secreto/);
    delete process.env.ANTHROPIC_API_KEY;
    assert.equal(engineView().ai, "off");
    assert.equal(engineView().agent.engine, "plantilla");
  } finally {
    process.env = prev;
  }
});

test("buildOutbox: con la cola del latido, en cola es lo que el puente tiene o lo que llegó después", () => {
  const s = state([
    utt(1, T0 - 30_000, { text: "OBAC, Vigía: humo negro en el lado C." }),
    utt(2, T0 - 25_000, { text: "OBAC, Vigía: B-5 llegando." }),
    utt(3, T0 - 2_000, { text: "OBAC, Vigía: posible persona en ventana del tercer piso." }),
  ]);
  const queue = [{ text: "OBAC, Vigía: B-5 llegando.", priority: "resto", kind: null, incident_id: "i1", expires_at: iso(T0 + 20_000) }];
  const z = zello({ last_spoken: null, sent_at: iso(T0 - 8_000), queue });
  const o = buildOutbox({ state: s, zello: z, nowMs: T0, agentEnabled: true, unreadComms: 0, unseenMedia: 0, turns: TURNS });
  const byseq = new Map(o.recent.map((u) => [u.seq, u.state]));
  assert.equal(byseq.get(1), "salio", "antes del latido y fuera de la cola, aunque esté dentro de los 45 s");
  assert.equal(byseq.get(2), "en_cola");
  assert.equal(byseq.get(3), "en_cola", "posterior al latido: el puente aún no lo recoge");
  assert.deepEqual(o.waiting.map((u) => u.seq), [2, 3]);
  assert.equal(o.queue_exact, true);

  // Un puente anterior no manda la cola: se estima.
  const old = buildOutbox({ state: s, zello: zello({ last_spoken: null, sent_at: iso(T0 - 8_000) }), nowMs: T0, agentEnabled: true, unreadComms: 0, unseenMedia: 0, turns: TURNS });
  assert.equal(old.queue_exact, false);
  assert.equal(old.recent.find((u) => u.seq === 1)?.state, "en_cola");
});
