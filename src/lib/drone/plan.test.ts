import { test } from "node:test";
import assert from "node:assert/strict";
import type { DroneMission } from "@/lib/domain";
import { pickLiveMission } from "@/lib/drone/plan";

function m(over: Partial<DroneMission>): DroneMission {
  return {
    id: "x",
    incident_id: "i",
    label: "D1",
    status: "on_station",
    mode: "device",
    pattern: "hover",
    radius_m: 0,
    altitude_m: 40,
    speed_ms: 5,
    home_lat: 0,
    home_lng: 0,
    waypoints: [],
    command: "continue",
    last: null,
    track: [],
    frames_received: 0,
    created_at: "2026-11-22T10:00:00.000Z",
    started_at: null,
    ended_at: null,
    ...over,
  };
}

test("una misión recién planificada no le quita el lugar a la que vuela", () => {
  // Caso real: D1 (teléfono) en vuelo con telemetría de hace horas y sin cuadros por lotes; D2 recién planificada.
  const streaming = m({
    id: "d1",
    created_at: "2026-11-21T15:54:49.425Z",
    last: { at: "2026-11-21T16:05:55.580Z", lat: 0, lng: 0, alt_m: 0, heading_deg: 0, speed_ms: null, battery_pct: null },
  });
  const planned = m({ id: "d2", mode: "api", status: "planned", created_at: "2026-11-22T01:28:58.638Z" });
  assert.equal(pickLiveMission([streaming, planned])?.id, "d1");
  assert.equal(pickLiveMission([planned, streaming])?.id, "d1");
});

test("ignora terminadas; entre las que vuelan gana la más reciente", () => {
  const landed = m({ id: "l", status: "landed", frames_received: 5 });
  const a = m({ id: "a", last: { at: "2026-11-22T10:00:01.000Z", lat: 0, lng: 0, alt_m: 0, heading_deg: 0, speed_ms: null, battery_pct: null } });
  const b = m({ id: "b", last: { at: "2026-11-22T10:00:09.000Z", lat: 0, lng: 0, alt_m: 0, heading_deg: 0, speed_ms: null, battery_pct: null } });
  assert.equal(pickLiveMission([landed, a, b])?.id, "b");
  assert.equal(pickLiveMission([landed]), null);
  // Ninguna vuela todavía: la más reciente (muestra "esperando video").
  assert.equal(pickLiveMission([m({ id: "old", status: "planned" }), m({ id: "new", status: "planned", created_at: "2026-11-22T11:00:00.000Z" })])?.id, "new");
});
