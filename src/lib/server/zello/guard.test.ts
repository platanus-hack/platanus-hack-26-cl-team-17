import assert from "node:assert/strict";
import { test } from "node:test";
import type { ZelloBridgeStatus, ZelloStatusResponse } from "@/lib/contract";
import { otherBridgeOnline } from "./guard";

const status = (over: Partial<ZelloBridgeStatus> = {}): ZelloBridgeStatus => ({
  connected: true,
  channel: "demo-platanus",
  users_online: 3,
  listen_only: false,
  error: null,
  incident_codes: [],
  last_transmission: null,
  last_spoken: null,
  sent_at: "2026-11-21T19:00:00.000Z",
  ...over,
});
const res = (s: ZelloBridgeStatus | null, stale = false): ZelloStatusResponse => ({ status: s, received_at: s ? "2026-11-21T19:00:01.000Z" : null, stale });

test("traba del puente: otro conectado y latiendo impide arrancar", () => {
  assert.match(otherBridgeOnline(res(status())) ?? "", /ya hay un puente Zello conectado al canal «demo-platanus»/);
});

test("traba del puente: sin puente, detenido, desconectado o sin latido reciente se puede arrancar", () => {
  assert.equal(otherBridgeOnline(null), null);
  assert.equal(otherBridgeOnline(res(null)), null);
  assert.equal(otherBridgeOnline(res(status({ stopped: true }))), null);
  assert.equal(otherBridgeOnline(res(status({ connected: false }))), null);
  assert.equal(otherBridgeOnline(res(status(), true)), null);
});
