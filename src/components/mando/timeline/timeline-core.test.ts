import { test } from "node:test";
import assert from "node:assert/strict";
import {
  advanceSeen,
  clearFresh,
  countByFilter,
  filterEvents,
  groupTimeline,
  initSeen,
  isTrivialDroneEvent,
  matchesFilter,
  splitEngineNote,
  type TimelineBurstRow,
} from "./timeline-core";
import { droneTick, ev } from "./fixtures.test-helpers";

test("filtros: cada evento cae donde corresponde", () => {
  const alert = ev({ kind: "alert", severity: "critical", title: "Posible persona atrapada", media_id: "med_2" });
  const received = ev({ kind: "media_received", media_id: "med_3" });
  const comms = ev({ kind: "comms", comm_id: "com_1" });
  const commsAlert = ev({ kind: "comms_alert", severity: "critical", comm_id: "com_2" });
  const drone = droneTick();
  const droneMedia = ev({ kind: "media_received", media_id: "med_4", mission_id: "mis_1" });
  const err = ev({ kind: "error", severity: "info" });
  const updated = ev({ kind: "situation_updated", severity: "notice" });

  assert.ok(matchesFilter(alert, "alerts") && matchesFilter(alert, "media"));
  assert.ok(!matchesFilter(alert, "comms") && !matchesFilter(alert, "drone"));
  assert.ok(matchesFilter(received, "media") && !matchesFilter(received, "alerts"));
  assert.ok(matchesFilter(comms, "comms") && !matchesFilter(comms, "alerts"));
  assert.ok(matchesFilter(commsAlert, "comms") && matchesFilter(commsAlert, "alerts"));
  assert.ok(matchesFilter(drone, "drone") && !matchesFilter(drone, "media"));
  assert.ok(matchesFilter(droneMedia, "drone") && matchesFilter(droneMedia, "media"));
  assert.ok(matchesFilter(err, "alerts"), "un error siempre es alerta aunque su severidad sea info");
  assert.ok(!matchesFilter(updated, "alerts") && matchesFilter(updated, "all"));

  const all = [alert, received, comms, commsAlert, drone, droneMedia, err, updated];
  const { counts, hasCritical } = countByFilter(all);
  assert.deepEqual(counts, { all: 8, alerts: 3, media: 3, comms: 2, drone: 2 });
  assert.equal(hasCritical, true);
  assert.equal(countByFilter([received]).hasCritical, false);
});

test("filterEvents conserva el orden de entrada y 'all' devuelve el mismo arreglo", () => {
  const list = [ev({ kind: "comms", comm_id: "c1" }), ev(), ev({ kind: "comms", comm_id: "c2" })];
  assert.equal(filterEvents(list, "all"), list);
  assert.deepEqual(filterEvents(list, "comms").map((e) => e.comm_id), ["c1", "c2"]);
});

test("isTrivialDroneEvent: solo eventos informativos del dron sin medio ni radio", () => {
  assert.equal(isTrivialDroneEvent(droneTick()), true);
  assert.equal(isTrivialDroneEvent(droneTick("mis_1", { severity: "notice" })), false);
  assert.equal(isTrivialDroneEvent(droneTick("mis_1", { severity: "warning" })), false);
  assert.equal(isTrivialDroneEvent(droneTick("mis_1", { media_id: "med_1" })), false);
  assert.equal(isTrivialDroneEvent(ev({ kind: "media_received" })), false);
});

test("groupTimeline pliega rachas de ≥3 eventos triviales del dron y deja las cortas sueltas", () => {
  const a = ev({ kind: "alert", severity: "warning" });
  const d1 = droneTick("mis_1");
  const d2 = droneTick("mis_2");
  const d3 = droneTick("mis_1");
  const b = ev({ kind: "comms", comm_id: "c1" });
  const d4 = droneTick();
  const d5 = droneTick();
  const abort = droneTick("mis_1", { severity: "warning", title: "Orden al dron D1: abortar" });
  const d6 = droneTick();
  const d7 = droneTick();
  const d8 = droneTick();

  const rows = groupTimeline([a, d1, d2, d3, b, d4, d5, abort, d6, d7, d8]);
  assert.deepEqual(
    rows.map((r) => (r.type === "event" ? r.event.id : `[${r.events.map((e) => e.id).join(",")}]`)),
    [a.id, `[${d1.id},${d2.id},${d3.id}]`, b.id, d4.id, d5.id, abort.id, `[${d6.id},${d7.id},${d8.id}]`],
  );
  const first = rows[1] as TimelineBurstRow;
  assert.equal(first.newestAt, d1.at);
  assert.equal(first.oldestAt, d3.at);
  assert.deepEqual(first.missionIds, ["mis_1", "mis_2"]);
  assert.equal(first.key, `burst:${d3.id}`);
});

test("groupTimeline: la clave de la racha es estable cuando llegan eventos nuevos arriba", () => {
  const older = [droneTick(), droneTick(), droneTick()];
  const before = groupTimeline(older);
  const after = groupTimeline([droneTick(), droneTick(), ...older]);
  assert.equal(before.length, 1);
  assert.equal(after.length, 1);
  assert.equal(before[0].key, after[0].key);
  assert.equal((after[0] as TimelineBurstRow).events.length, 5);
});

test("groupTimeline con 200 eventos: una pasada, sin perder ninguno", () => {
  const list = Array.from({ length: 200 }, (_, i) =>
    i % 10 === 0 ? ev({ kind: "alert", severity: "critical" }) : droneTick(),
  );
  const rows = groupTimeline(list);
  const total = rows.reduce((n, r) => n + (r.type === "event" ? 1 : r.events.length), 0);
  assert.equal(total, 200);
  assert.equal(rows.length, 40);
  assert.equal(groupTimeline([]).length, 0);
});

test("advanceSeen: la primera carga no se resalta; solo lo nuevo después", () => {
  const e1 = ev();
  const e2 = ev();
  let s = initSeen([]);
  assert.equal(s.baseline, false);

  // Primera carga con datos (llegó tras el sondeo inicial): es la base, nada resaltado.
  s = advanceSeen(s, [e2, e1]);
  assert.equal(s.fresh.size, 0);
  assert.equal(s.baseline, true);

  const e3 = ev();
  const e4 = ev();
  s = advanceSeen(s, [e4, e3, e2, e1]);
  assert.deepEqual([...s.fresh].sort(), [e3.id, e4.id].sort());

  // Un sondeo sin novedades (arreglo nuevo, mismos ids) mantiene el resaltado vigente.
  const freshBefore = s.fresh;
  s = advanceSeen(s, [e4, e3, e2, e1]);
  assert.equal(s.fresh, freshBefore);

  // Mismo arreglo → mismo estado.
  assert.equal(advanceSeen(s, s.source), s);

  // Limpiar solo si sigue siendo el mismo conjunto.
  assert.equal(clearFresh(s, new Set(["otro"])), s);
  s = clearFresh(s, freshBefore);
  assert.equal(s.fresh.size, 0);

  // Un evento que reaparece tras salir de la ventana de 200 no vuelve a resaltarse.
  s = advanceSeen(s, [e2, e1]);
  s = advanceSeen(s, [e4, e2, e1]);
  assert.equal(s.fresh.size, 0);
});

test("initSeen con eventos marca la base de inmediato", () => {
  const s = initSeen([ev(), ev()]);
  assert.equal(s.baseline, true);
  assert.equal(s.seen.size, 2);
  assert.equal(s.fresh.size, 0);
});

test("splitEngineNote: quita el sufijo del motor de reglas (completo o recortado) y lo marca simulado", () => {
  assert.deepEqual(splitEngineNote("Escena actualizada (motor de reglas, sin modelo)"), { text: "Escena actualizada", simulated: true });
  assert.deepEqual(splitEngineNote("Atrapados: posible. Indicio (motor de re…"), { text: "Atrapados: posible. Indicio…", simulated: true });
  // Paréntesis que no son el sufijo quedan intactos.
  assert.deepEqual(splitEngineNote("Silueta en ventana (M2 · cuadro 3)"), { text: "Silueta en ventana (M2 · cuadro 3)", simulated: false });
  assert.deepEqual(splitEngineNote("Humo negro (M…"), { text: "Humo negro (M…", simulated: false });
  assert.deepEqual(splitEngineNote(""), { text: "", simulated: false });
});
