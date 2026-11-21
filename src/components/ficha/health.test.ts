import { test } from "node:test";
import assert from "node:assert/strict";
import type { ZelloStatusResponse } from "@/lib/contract";
import { sinIA } from "@/components/vigia/sin-ia";
import { healthChips } from "./health";

const zello = (over: Partial<NonNullable<ZelloStatusResponse["status"]>>, stale = false): ZelloStatusResponse => ({
  status: {
    connected: true,
    channel: "demo-platanus",
    users_online: 2,
    listen_only: false,
    error: null,
    incident_codes: [],
    last_transmission: null,
    last_spoken: null,
    sent_at: "2026-11-21T19:00:00.000Z",
    ...over,
  },
  received_at: "2026-11-21T19:00:00.000Z",
  stale,
});
const NOW = Date.parse("2026-11-21T19:00:40.000Z");
const ok = { stale: false, lastUpdatedAt: NOW - 1000, now: NOW, zello: zello({}), vigia: { ai_off: false, last_error: null } };

test("ficha: si todo anda, la barra no muestra avisos", () => {
  assert.deepEqual(healthChips(ok), []);
  // Sin puente Zello configurado (modo local) no es una falla.
  assert.deepEqual(healthChips({ ...ok, zello: { status: null, received_at: null, stale: false } }), []);
});

test("ficha: sin conexión, Zello expulsado y Vigía sin IA se ven en la barra", () => {
  const chips = healthChips({
    stale: true,
    lastUpdatedAt: NOW - 40_000,
    now: NOW,
    zello: zello({ connected: false, error: "otra sesión con la misma cuenta de Zello tomó la conexión" }),
    vigia: { ai_off: false, last_error: "Claude falló (Request timed out.); respondo con plantillas por 2 min y después vuelvo a probar." },
  });
  assert.deepEqual(
    chips.map((c) => [c.id, c.tone, c.label]),
    [
      ["red", "critical", "Sin conexión · hace 40 s"],
      ["zello", "critical", "Zello desconectado"],
      ["vigia", "warning", "Vigía sin IA: Claude no responde"],
    ],
  );
  assert.match(chips[1].hint, /otra sesión/);
  assert.equal(healthChips({ ...ok, zello: zello({}, true) })[0]?.label, "Zello sin señal del puente");
});

test("Vigía sin IA: activado por la mesa, por Claude caído, o por otra falla de la vuelta", () => {
  assert.equal(sinIA({ ai_off: true, last_error: null })?.title, "Vigía sin IA");
  assert.equal(sinIA({ ai_off: false, last_error: "Claude falló (529 Overloaded)" })?.title, "Vigía sin IA: Claude no responde");
  assert.equal(sinIA({ ai_off: false, last_error: "connect ECONNREFUSED" })?.title, "Vigía: falló la última vuelta");
  assert.equal(sinIA({ ai_off: false, last_error: null }), null);
  assert.equal(sinIA(null), null);
});
