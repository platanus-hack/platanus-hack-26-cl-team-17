import assert from "node:assert/strict";
import { test } from "node:test";
import { toStatusResponse, ZELLO_STALE_MS, ZelloBridgeStatusSchema } from "./status";

const STATUS = {
  connected: true,
  channel: "demo-platanus",
  users_online: 2,
  listen_only: false,
  error: null,
  incident_codes: ["VG-AB12"],
  last_transmission: null,
  last_spoken: { at: "2026-11-21T18:00:00.000Z", text: "Resumen".repeat(100) },
  sent_at: "2026-11-21T18:00:00.000Z",
};

test("el esquema del latido acepta el estado del puente y recorta textos largos", () => {
  const parsed = ZelloBridgeStatusSchema.parse(STATUS);
  assert.equal(parsed.last_spoken?.text.length, 300);
  assert.throws(() => ZelloBridgeStatusSchema.parse({ ...STATUS, connected: "sí" }));
});

test("toStatusResponse marca stale pasado el límite y sin latido", () => {
  const received = Date.parse("2026-11-21T18:00:00.000Z");
  const stored = { status: ZelloBridgeStatusSchema.parse(STATUS), received_at: "2026-11-21T18:00:00.000Z" };
  assert.equal(toStatusResponse(stored, received + 5_000).stale, false);
  assert.equal(toStatusResponse(stored, received + ZELLO_STALE_MS + 1).stale, true);
  assert.deepEqual(toStatusResponse(null, received), { status: null, received_at: null, stale: true });
});
