import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncidentSummary } from "@/lib/contract";
import {
  dashboardCounts,
  filterCounts,
  filterIncidents,
  isIncidentFilter,
  sortByUrgency,
  splitUnverifiedCitizen,
  urgencyScore,
} from "./urgency";

let seq = 0;
function inc(p: Partial<IncidentSummary> & { id: string }): IncidentSummary {
  seq++;
  return {
    code: `C${seq}`,
    type: "structure_fire",
    title: p.id,
    address: "Calle 1",
    lat: -33.4,
    lng: -70.6,
    status: "active",
    origin: "command",
    verified: true,
    created_at: "2026-11-21T10:00:00.000Z",
    updated_at: "2026-11-21T10:00:00.000Z",
    rev: 1,
    headline: null,
    severity: null,
    trapped_status: null,
    media_count: 0,
    comms_count: 0,
    active_missions: 0,
    ...p,
  };
}

const ids = (l: IncidentSummary[]) => l.map((i) => i.id);

test("atrapados confirmados antes que probables, luego gravedad crítica", () => {
  const list = [
    inc({ id: "crit", severity: "critical" }),
    inc({ id: "prob", trapped_status: "probable", severity: "low" }),
    inc({ id: "high", severity: "high" }),
    inc({ id: "conf", trapped_status: "confirmed", severity: "moderate" }),
    inc({ id: "possible", trapped_status: "possible", severity: "moderate" }),
  ];
  assert.deepEqual(ids(sortByUrgency(list)), ["conf", "prob", "crit", "high", "possible"]);
});

test("entre activos del mismo nivel: gravedad desc y luego el más reciente", () => {
  const list = [
    inc({ id: "old-mod", severity: "moderate", created_at: "2026-11-21T08:00:00Z" }),
    inc({ id: "none", severity: null, created_at: "2026-11-21T12:00:00Z" }),
    inc({ id: "new-mod", severity: "moderate", created_at: "2026-11-21T09:00:00Z" }),
    inc({ id: "low", severity: "low", created_at: "2026-11-21T13:00:00Z" }),
  ];
  assert.deepEqual(ids(sortByUrgency(list)), ["new-mod", "old-mod", "low", "none"]);
});

test("controlados después de activos y cerrados al final, aunque tengan atrapados", () => {
  const list = [
    inc({ id: "closed-conf", status: "closed", trapped_status: "confirmed" }),
    inc({ id: "ctrl-conf", status: "controlled", trapped_status: "confirmed" }),
    inc({ id: "active-low", severity: "low" }),
    inc({ id: "ctrl-crit", status: "controlled", severity: "critical" }),
  ];
  assert.deepEqual(ids(sortByUrgency(list)), ["active-low", "ctrl-conf", "ctrl-crit", "closed-conf"]);
});

test("orden estable en empates exactos y no muta la entrada", () => {
  const list = [inc({ id: "a" }), inc({ id: "b" }), inc({ id: "c" })];
  const copy = list.slice();
  assert.deepEqual(ids(sortByUrgency(list)), ["a", "b", "c"]);
  assert.deepEqual(list, copy);
});

test("fecha inválida queda después de las válidas del mismo nivel", () => {
  const list = [inc({ id: "bad", created_at: "x" }), inc({ id: "ok", created_at: "2026-01-01T00:00:00Z" })];
  assert.deepEqual(ids(sortByUrgency(list)), ["ok", "bad"]);
});

test("urgencyScore: confirmado > probable > crítico > resto; activo > controlado", () => {
  const conf = urgencyScore(inc({ id: "1", trapped_status: "confirmed" }));
  const prob = urgencyScore(inc({ id: "2", trapped_status: "probable", severity: "critical" }));
  const crit = urgencyScore(inc({ id: "3", severity: "critical" }));
  const high = urgencyScore(inc({ id: "4", severity: "high" }));
  const ctrl = urgencyScore(inc({ id: "5", status: "controlled", trapped_status: "confirmed", severity: "critical" }));
  assert.ok(conf > prob && prob > crit && crit > high && high > ctrl);
});

test("filterIncidents por estado y 'all'", () => {
  const list = [
    inc({ id: "a" }),
    inc({ id: "c", status: "controlled" }),
    inc({ id: "x", status: "closed" }),
  ];
  assert.deepEqual(ids(filterIncidents(list, "active")), ["a"]);
  assert.deepEqual(ids(filterIncidents(list, "controlled")), ["c"]);
  assert.deepEqual(ids(filterIncidents(list, "closed")), ["x"]);
  assert.deepEqual(ids(filterIncidents(list, "all")), ["a", "c", "x"]);
  assert.notEqual(filterIncidents(list, "all"), list);
});

test("splitUnverifiedCitizen: solo ciudadanos sin verificar y no cerrados", () => {
  const list = [
    inc({ id: "cit", origin: "citizen", verified: false }),
    inc({ id: "cit-ok", origin: "citizen", verified: true }),
    inc({ id: "cit-closed", origin: "citizen", verified: false, status: "closed" }),
    inc({ id: "cit-ctrl", origin: "citizen", verified: false, status: "controlled" }),
    inc({ id: "demo", origin: "demo", verified: false }),
    inc({ id: "cmd", origin: "command" }),
  ];
  const { unverified, rest } = splitUnverifiedCitizen(list);
  assert.deepEqual(ids(unverified), ["cit", "cit-ctrl"]);
  assert.deepEqual(ids(rest), ["cit-ok", "cit-closed", "demo", "cmd"]);
});

test("dashboardCounts", () => {
  const list = [
    inc({ id: "1", trapped_status: "confirmed" }),
    inc({ id: "2", trapped_status: "probable", status: "controlled" }),
    inc({ id: "3", trapped_status: "confirmed", status: "closed" }),
    inc({ id: "4", trapped_status: "possible" }),
    inc({ id: "5", trapped_status: "no_evidence" }),
    inc({ id: "6", origin: "citizen", verified: false }),
    inc({ id: "7", origin: "citizen", verified: false, status: "closed" }),
  ];
  assert.deepEqual(dashboardCounts(list), { active: 4, trapped: 2, unverified: 1 });
  assert.deepEqual(dashboardCounts([]), { active: 0, trapped: 0, unverified: 0 });
});

test("filterCounts e isIncidentFilter", () => {
  const list = [inc({ id: "a" }), inc({ id: "b", status: "closed" }), inc({ id: "c" })];
  assert.deepEqual(filterCounts(list), { active: 2, controlled: 0, closed: 1, all: 3 });
  assert.ok(isIncidentFilter("closed"));
  assert.ok(!isIncidentFilter("nope"));
  assert.ok(!isIncidentFilter(null));
});
