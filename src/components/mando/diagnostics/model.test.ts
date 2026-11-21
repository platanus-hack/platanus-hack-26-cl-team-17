/**
 * Tono y texto de cada subsistema en la banda de la vista técnica.
 *   node --import tsx --test src/components/mando/diagnostics/model.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { IncidentDiagnostics, ZelloBridgeStatus } from "@/lib/contract";
import { BRIDGE, CALL, diag, iso, T0, utt } from "./fixtures.test-helpers";
import { agoText, formatMs, subsystems, voiceFreeInMs, worstTone, zelloState, type SubsystemId } from "./model";

function tone(d: IncidentDiagnostics, id: SubsystemId, now = T0) {
  return subsystems(d, now).find((s) => s.id === id)!;
}

test("formatos cortos", () => {
  assert.equal(formatMs(850), "850 ms");
  assert.equal(formatMs(2_140), "2,1 s");
  assert.equal(formatMs(65_000), "1 min 5 s");
  assert.equal(agoText(iso(T0 - 4_000), T0), "hace 4 s");
  assert.equal(agoText(iso(T0 - 125_000), T0), "hace 2 min 5 s");
  assert.equal(agoText(null, T0), "nunca");
});

test("todo sano: la banda queda en verde", () => {
  const items = subsystems(diag(), T0);
  assert.deepEqual(
    items.map((s) => s.id),
    ["motor", "zello", "claude", "detector", "salida", "errores"],
  );
  assert.equal(worstTone(items), "ok");
  assert.equal(tone(diag(), "zello").value, "conectado · latido hace 4 s");
  assert.equal(tone(diag(), "claude").value, "2,1 s · p50 2,1 s");
});

test("Zello: latido viejo en rojo, solo escucha en ámbar, sin puente en gris", () => {
  const z = (over: Partial<IncidentDiagnostics["zello"]>, status: Partial<ZelloBridgeStatus> = {}) =>
    diag({ zello: { status: { ...BRIDGE, ...status }, received_at: iso(T0 - 4_000), stale: false, ...over } });
  // Más de 30 s sin latido: rojo aunque el servidor aún no lo marque como stale.
  const late = z({ received_at: iso(T0 - 31_000) });
  assert.equal(zelloState(late.zello, T0), "sin_latido");
  assert.equal(tone(late, "zello").tone, "critical");
  assert.equal(tone(late, "zello").value, "sin latido hace 31 s");
  assert.equal(tone(z({}, { listen_only: true }), "zello").tone, "warning");
  assert.equal(tone(z({}, { connected: false, error: "Zello rechazó el token" }), "zello").tone, "critical");
  assert.equal(tone(z({ stale: true }, { stopped: true }), "zello").tone, "muted");
  const none = diag({ zello: { status: null, received_at: null, stale: true } });
  assert.equal(tone(none, "zello").tone, "muted");
  assert.equal(tone(none, "zello").value, "sin puente");
});

test("Motor simulado: se dice claramente", () => {
  const d = diag({ engine: { ...diag().engine, ai: "simulated", has_credential: false }, claude: { calls: [], total: 0, errors: 0, p50_ms: null, max_ms: null } });
  const m = tone(d, "motor");
  assert.equal(m.value, "SIMULADO");
  assert.equal(m.tone, "warning");
  assert.match(m.hint, /no hay credencial/);
  assert.equal(tone(d, "claude").tone, "muted");
});

test("Claude: la última falló en rojo; errores previos o lentitud en ámbar", () => {
  const failed = { ...CALL, ok: false, status: 429, error: "RateLimitError: 429" };
  assert.equal(tone(diag({ claude: { calls: [failed, CALL], total: 2, errors: 1, p50_ms: 2100, max_ms: 2100 } }), "claude").tone, "critical");
  assert.equal(tone(diag({ claude: { calls: [failed, CALL], total: 2, errors: 1, p50_ms: 2100, max_ms: 2100 } }), "claude").value, "última falló (HTTP 429)");
  assert.equal(tone(diag({ claude: { calls: [CALL, failed], total: 2, errors: 1, p50_ms: 2100, max_ms: 2100 } }), "claude").tone, "warning");
  assert.equal(tone(diag({ claude: { calls: [{ ...CALL, ms: 25_000 }], total: 1, errors: 0, p50_ms: 25_000, max_ms: 25_000 } }), "claude").tone, "warning");
});

test("Detector: caído en rojo, atrasado en ámbar, sin configurar en gris", () => {
  const base = diag().detector;
  assert.equal(tone(diag({ detector: { ...base, healthy: false } }), "detector").tone, "critical");
  assert.equal(tone(diag({ detector: { ...base, configured: false, healthy: null } }), "detector").tone, "muted");
  const feed = {
    mission_id: "m1",
    label: "D1",
    active: true,
    receiving: true,
    last_frame_at: iso(T0 - 200),
    last_detection_at: iso(T0 - 9_000),
    last_detection: "persona",
    last_detection_ms: 120,
    detecting: true,
    observer: { analyzing: false, last_at: null, engine: null, summary: null },
  };
  const lag = tone(diag({ detector: { ...base, live: [feed] } }), "detector");
  assert.equal(lag.tone, "warning");
  assert.match(lag.value, /D1 atrasado 8,8 s/);
  const queued = { ...base.media, total: 1, queued: 1, oldest_pending: { label: "M2", since: iso(T0 - 180_000), status: "uploaded" as const } };
  assert.equal(tone(diag({ detector: { ...base, media: queued } }), "detector").tone, "warning");
});

test("Salida de Vigía: error, cola atascada, silencio y ventana de voz", () => {
  const o = diag().outbox;
  assert.equal(tone(diag({ outbox: { ...o, last_error: "Claude falló" } }), "salida").tone, "critical");
  const stuck = tone(diag({ outbox: { ...o, waiting: [utt(3, T0 - 30_000, "en_cola")] } }), "salida");
  assert.equal(stuck.tone, "warning");
  assert.match(stuck.value, /1 en cola hace 30 s/);
  assert.equal(tone(diag({ outbox: { ...o, silenced: true } }), "salida").tone, "warning");
  assert.equal(tone(diag({ outbox: { ...o, agent_enabled: false } }), "salida").tone, "muted");
  // Sin puente configurado nunca, que no haya quién lo diga no es una falla.
  const noBridge = diag({ zello: { status: null, received_at: null, stale: true }, outbox: { ...o, recent: [utt(2, T0 - 5_000, "sin_puente")] } });
  assert.equal(tone(noBridge, "salida").tone, "ok");
  const withBridge = diag({ outbox: { ...o, recent: [utt(2, T0 - 5_000, "sin_puente")] } });
  assert.equal(tone(withBridge, "salida").tone, "warning");
  // 20 s desde lo último hablado (agente o puente, lo más reciente).
  const spoken = diag({ outbox: { ...o, last_spoken_at: iso(T0 - 8_000), bridge_spoken: { at: iso(T0 - 5_000), text: "x" } } });
  assert.equal(voiceFreeInMs(spoken, T0), 15_000);
  assert.equal(tone(spoken, "salida").value, "voz en 15 s");
  assert.equal(voiceFreeInMs(diag(), T0), null);
  // Radio sin leer y sin vueltas recientes: atrasada.
  const late = diag({ outbox: { ...o, unread_comms: 2, last_turn: { at: iso(T0 - 40_000), ms: 3, thought: false, engine: null, events: [] } } });
  assert.equal(tone(late, "salida").tone, "warning");
});

test("Errores: recientes en rojo, de hace minutos en ámbar, viejos en verde", () => {
  const e = (ago: number) => ({ at: iso(T0 - ago), first_at: iso(T0 - ago), count: 1, source: "transcripcion" as const, message: "ElevenLabs respondió 401", incident_id: null, incident_code: null });
  assert.equal(tone(diag({ errors: [e(30_000)] }), "errores").tone, "critical");
  assert.match(tone(diag({ errors: [e(30_000)] }), "errores").value, /Transcripción/);
  assert.equal(tone(diag({ errors: [e(5 * 60_000)] }), "errores").tone, "warning");
  assert.equal(tone(diag({ errors: [e(60 * 60_000)] }), "errores").tone, "ok");
});
