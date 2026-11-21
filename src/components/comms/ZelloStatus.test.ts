import assert from "node:assert/strict";
import { test } from "node:test";
import type { ZelloBridgeStatus } from "@/lib/contract";
import { zelloLine } from "./ZelloStatus";

const BASE: ZelloBridgeStatus = {
  connected: true,
  channel: "demo-platanus",
  users_online: 3,
  listen_only: false,
  error: null,
  incident_codes: ["VG-AB12"],
  last_transmission: { at: "2026-11-21T17:02:00.000Z", from: "B-3", text: "en 6-3" },
  last_spoken: null,
  sent_at: "2026-11-21T17:02:05.000Z",
};

test("zelloLine: conectado muestra canal, usuarios y última transmisión", () => {
  const l = zelloLine({ status: BASE, received_at: "2026-11-21T17:02:05.000Z", stale: false });
  assert.equal(l.tone, "ok");
  assert.equal(l.title, "Zello · demo-platanus · 3 en línea");
  assert.match(l.detail ?? "", /^Última: \d\d:\d\d(:\d\d)? B-3$/);
  assert.match(l.hint, /VG-AB12/);
});

test("zelloLine: sin puente, sin señal y desconectado se distinguen", () => {
  assert.equal(zelloLine(null).title, "Zello sin puente");
  assert.equal(zelloLine({ status: null, received_at: null, stale: true }).tone, "muted");
  const stale = zelloLine({ status: BASE, received_at: "2026-11-21T17:02:05.000Z", stale: true });
  assert.equal(stale.tone, "warning");
  assert.equal(stale.title, "Zello sin señal del puente");
  const off = zelloLine({ status: { ...BASE, connected: false, error: "Zello rechazó el usuario, la clave o el token" }, received_at: BASE.sent_at, stale: false });
  assert.equal(off.tone, "critical");
  assert.equal(off.detail, "Zello rechazó el usuario, la clave o el token");
  assert.match(zelloLine({ status: { ...BASE, listen_only: true }, received_at: BASE.sent_at, stale: false }).detail ?? "", /solo escucha/);
});

test("zelloLine: el puente detenido a propósito no se confunde con una caída", () => {
  const l = zelloLine({ status: { ...BASE, stopped: true, connected: false }, received_at: BASE.sent_at, stale: true });
  assert.equal(l.title, "Zello: puente detenido");
  assert.equal(l.tone, "muted");
  const said = zelloLine({ status: { ...BASE, last_spoken: { at: BASE.sent_at, text: "Resumen" } }, received_at: BASE.sent_at, stale: false });
  assert.match(said.detail ?? "", /Vigía habló/);
});
