import { test } from "node:test";
import assert from "node:assert/strict";
import type { BriefingSnapshot } from "@/lib/contract";
import type { SituationReport } from "@/lib/domain";
import {
  autoReadText,
  diffBriefing,
  googleMapsUrl,
  isSimulated,
  mergeChanges,
  normalizeText,
  sortHazards,
  speechSignature,
  trappedCountText,
  updatedAgoText,
  wazeUrl,
} from "./briefing-diff";

function situation(over: Partial<SituationReport> = {}): SituationReport {
  return {
    headline: "Casa de 2 pisos con fuego en 2º piso",
    incident_type: "structure_fire",
    severity: "high",
    trapped: { status: "possible", count_min: 1, count_max: 1, locations: ["2º piso"], basis: "M1", evidence: [] },
    injured: { status: "no_evidence", count_estimate: 0, detail: "" },
    fire: { present: true, stage: "growth", location: "2º piso", spread: "", smoke: "" },
    structure: { description: "", floors: 2, construction: "unknown", exposures: "" },
    vehicles: { count: 0, description: "", entrapment: "no_evidence", details: "" },
    hazards: [{ kind: "power_lines", description: "Cables sobre el antejardín", severity: "medium", evidence: [] }],
    access: { best_approach: "Por calle Los Aromos", obstructions: [], water_supply: "", staging_suggestion: "" },
    insights: [],
    contradictions: [],
    unknowns: ["¿Hay gas en la cocina?"],
    recommended_actions: [],
    briefing: { spoken: "Incendio en casa de dos pisos.", bullets: ["Fuego 2º piso"] },
    overall_confidence: "medium",
    ...over,
  };
}

function snap(over: { situation?: SituationReport | null; incident?: Partial<BriefingSnapshot["incident"]> } = {}): BriefingSnapshot {
  return {
    incident: {
      id: "inc1",
      code: "VG-7K3Q",
      type: "structure_fire",
      title: "Incendio",
      address: "Los Aromos 123",
      lat: -33.4489,
      lng: -70.6693,
      status: "active",
      verified: true,
      rev: 1,
      created_at: "2026-11-21T10:00:00.000Z",
      situation_updated_at: null,
      situation_engine: "claude",
      scene_engine: "claude",
      ...over.incident,
    },
    situation: over.situation === undefined ? situation() : over.situation,
    scene: null,
    key_frames: [],
    media_count: 1,
    mode: { store: "local", files: "local", ai: "claude", auth: "open", model: null },
    server_time: "2026-11-21T10:05:00.000Z",
  };
}

test("primer snapshot: sin cambios ni aviso", () => {
  assert.deepEqual(diffBriefing(null, snap()), { important: false, changes: [] });
});

test("snapshot de otro incidente se trata como primero", () => {
  const d = diffBriefing(snap(), snap({ incident: { id: "otro" }, situation: situation({ severity: "critical" }) }));
  assert.equal(d.important, false);
  assert.equal(d.changes.length, 0);
});

test("mismo contenido: sin cambios", () => {
  const d = diffBriefing(snap(), snap({ incident: { rev: 2 } }));
  assert.equal(d.important, false);
  assert.equal(d.changes.length, 0);
});

test("cambio de estado de atrapados es importante y nombra antes/ahora", () => {
  const next = snap({ situation: situation({ trapped: { ...situation().trapped, status: "probable" } }) });
  const d = diffBriefing(snap(), next);
  assert.equal(d.important, true);
  const c = d.changes.find((x) => x.kind === "trapped");
  assert.ok(c);
  assert.match(c.text, /ahora PROBABLE/);
  assert.match(c.text, /antes POSIBLE/);
});

test("pasar a sin evidencia nunca se lee como 'sin víctimas'", () => {
  const next = snap({ situation: situation({ trapped: { ...situation().trapped, status: "no_evidence", count_min: 0, count_max: 0 } }) });
  const c = diffBriefing(snap(), next).changes.find((x) => x.kind === "trapped");
  assert.ok(c);
  assert.match(c.text, /no descarta/);
  assert.doesNotMatch(c.text, /sin víctimas|no hay personas|0 personas/i);
});

test("cambio solo de cantidad de atrapados", () => {
  const next = snap({ situation: situation({ trapped: { ...situation().trapped, count_min: 2, count_max: 3 } }) });
  const d = diffBriefing(snap(), next);
  assert.equal(d.important, true);
  const c = d.changes.find((x) => x.kind === "trapped_count");
  assert.ok(c);
  assert.match(c.text, /2 a 3 personas/);
  assert.match(c.text, /antes 1 persona/);
});

test("gravedad sube y baja", () => {
  const up = diffBriefing(snap(), snap({ situation: situation({ severity: "critical" }) }));
  assert.equal(up.important, true);
  assert.match(up.changes.find((c) => c.kind === "severity")?.text ?? "", /subió a Crítica \(antes Alta\)/);

  const down = diffBriefing(snap(), snap({ situation: situation({ severity: "moderate" }) }));
  assert.equal(down.important, true);
  assert.match(down.changes.find((c) => c.kind === "severity")?.text ?? "", /bajó a Moderada \(antes Alta\)/);
});

test("peligro de un tipo nuevo", () => {
  const hazards = [
    ...situation().hazards,
    { kind: "gas_cylinder" as const, description: "Cilindro junto a la puerta", severity: "high" as const, evidence: [] },
  ];
  const d = diffBriefing(snap(), snap({ situation: situation({ hazards }) }));
  assert.equal(d.important, true);
  const hz = d.changes.filter((c) => c.kind === "hazards");
  assert.equal(hz.length, 1);
  assert.match(hz[0].text, /Nuevo peligro: Cilindro de gas — Cilindro junto a la puerta/);
});

test("mismo tipo con descripción distinta y mayor cantidad: peligro nuevo", () => {
  const hazards = [
    ...situation().hazards,
    { kind: "power_lines" as const, description: "Poste caído en la esquina", severity: "medium" as const, evidence: [] },
  ];
  const hz = diffBriefing(snap(), snap({ situation: situation({ hazards }) })).changes.filter((c) => c.kind === "hazards");
  assert.equal(hz.length, 1);
  assert.match(hz[0].text, /Poste caído en la esquina/);
});

test("reformular la descripción de un peligro conocido no es nuevo", () => {
  const hazards = [{ kind: "power_lines" as const, description: "Tendido eléctrico sobre el jardín delantero", severity: "medium" as const, evidence: [] }];
  const d = diffBriefing(snap(), snap({ situation: situation({ hazards }) }));
  assert.equal(d.changes.filter((c) => c.kind === "hazards").length, 0);
  assert.equal(d.important, false);
});

test("descripción igual salvo tildes y mayúsculas tampoco es nueva", () => {
  assert.equal(normalizeText("  Cables SOBRE el antejardín! "), normalizeText("cables sobre el antejardin"));
});

test("peligro conocido que se agrava es importante", () => {
  const hazards = [{ kind: "power_lines" as const, description: "Cables sobre el antejardín", severity: "high" as const, evidence: [] }];
  const hz = diffBriefing(snap(), snap({ situation: situation({ hazards }) })).changes.filter((c) => c.kind === "hazards");
  assert.equal(hz.length, 1);
  assert.match(hz[0].text, /Peligro más grave \(alta\)/);
});

test("peligro que desaparece no se anuncia (no implica que esté resuelto)", () => {
  const d = diffBriefing(snap(), snap({ situation: situation({ hazards: [] }) }));
  assert.equal(d.changes.length, 0);
});

test("primer análisis: aviso importante con estado de atrapados y peligros altos", () => {
  const first = situation({
    trapped: { ...situation().trapped, status: "confirmed", count_min: 2, count_max: 2 },
    hazards: [
      { kind: "gas_cylinder", description: "Cilindro", severity: "high", evidence: [] },
      { kind: "traffic", description: "Tránsito", severity: "low", evidence: [] },
    ],
  });
  const d = diffBriefing(snap({ situation: null }), snap({ situation: first }));
  assert.equal(d.important, true);
  assert.match(d.changes[0].text, /Llegó el primer análisis\. Personas atrapadas: CONFIRMADO \(2 personas\)/);
  assert.equal(d.changes.filter((c) => c.kind === "hazards").length, 1);
});

test("ambos sin análisis: sin cambios", () => {
  const d = diffBriefing(snap({ situation: null }), snap({ situation: null, incident: { rev: 5 } }));
  assert.deepEqual(d, { important: false, changes: [] });
});

test("análisis que desaparece: aviso importante", () => {
  const d = diffBriefing(snap(), snap({ situation: null }));
  assert.equal(d.important, true);
  assert.equal(d.changes[0].kind, "situation");
});

test("cierre de la emergencia es importante; verificación no", () => {
  const closed = diffBriefing(snap(), snap({ incident: { status: "closed" } }));
  assert.equal(closed.important, true);
  assert.match(closed.changes[0].text, /CERRADA/);

  const verified = diffBriefing(snap({ incident: { verified: false } }), snap());
  assert.equal(verified.important, false);
  assert.equal(verified.changes[0].kind, "verified");
});

test("cambio de titular: informativo, no importante", () => {
  const d = diffBriefing(snap(), snap({ situation: situation({ headline: "Fuego se extiende al techo" }) }));
  assert.equal(d.important, false);
  assert.equal(d.changes[0].kind, "headline");
});

test("mergeChanges no repite y conserva los más recientes", () => {
  const a = { kind: "severity" as const, text: "A", important: true };
  const b = { kind: "trapped" as const, text: "B", important: true };
  assert.deepEqual(mergeChanges([a, b], [a]).map((c) => c.text), ["B", "A"]);
  const many = Array.from({ length: 10 }, (_, i) => ({ kind: "hazards" as const, text: `H${i}`, important: true }));
  assert.equal(mergeChanges([], many, 8).length, 8);
  assert.equal(mergeChanges([], many, 8)[0].text, "H2");
});

test("trappedCountText nunca muestra 0 y tolera rangos raros", () => {
  const t = situation().trapped;
  assert.equal(trappedCountText({ ...t, status: "no_evidence", count_min: 0, count_max: 0 }), null);
  assert.equal(trappedCountText({ ...t, status: "possible", count_min: 0, count_max: 0 }), "Cantidad sin determinar");
  assert.equal(trappedCountText({ ...t, count_min: 0, count_max: 2 }), "Hasta 2 personas");
  assert.equal(trappedCountText({ ...t, count_min: 3, count_max: 1 }), "3 personas");
  assert.equal(trappedCountText({ ...t, count_min: Number.NaN, count_max: -1, status: "probable" }), "Cantidad sin determinar");
});

test("autoReadText: relee con 'Actualización.' solo si cambió texto o atrapados", () => {
  const base = snap();
  const sig = speechSignature(base);
  assert.equal(autoReadText(undefined, base), null);
  assert.equal(autoReadText(sig, base), null);
  assert.equal(autoReadText(sig, snap({ incident: { rev: 9 } })), null);

  const spokenChanged = snap({ situation: situation({ briefing: { spoken: "Nuevo texto.", bullets: [] } }) });
  assert.equal(autoReadText(sig, spokenChanged), "Actualización. Nuevo texto.");

  const trappedChanged = snap({ situation: situation({ trapped: { ...situation().trapped, status: "confirmed" } }) });
  assert.equal(autoReadText(sig, trappedChanged), "Actualización. Incendio en casa de dos pisos.");

  // Primer análisis tras no tener ninguno: se lee.
  assert.equal(autoReadText(null, base), "Actualización. Incendio en casa de dos pisos.");
  // Sin análisis: nada que leer.
  assert.equal(autoReadText(sig, snap({ situation: null })), null);
});

test("isSimulated por motor o por modo sin análisis", () => {
  assert.equal(isSimulated(snap()), false);
  assert.equal(isSimulated(snap({ incident: { scene_engine: "simulated" } })), true);
  const s = snap({ situation: null, incident: { situation_engine: null, scene_engine: null } });
  assert.equal(isSimulated({ ...s, mode: { ...s.mode, ai: "simulated" } }), true);
  assert.equal(isSimulated(s), false);
});

test("enlaces de navegación", () => {
  assert.equal(googleMapsUrl(-33.4489, -70.6693), "https://www.google.com/maps/dir/?api=1&destination=-33.4489,-70.6693");
  assert.equal(wazeUrl(-33.4489, -70.6693), "https://waze.com/ul?ll=-33.4489,-70.6693&navigate=yes");
});

test("updatedAgoText", () => {
  assert.equal(updatedAgoText(null, 1000), null);
  assert.equal(updatedAgoText(1000, null), null);
  assert.equal(updatedAgoText(0, 8_400), "Actualizado hace 8 s");
  assert.equal(updatedAgoText(0, 125_000), "Actualizado hace 2 min");
  assert.equal(updatedAgoText(10_000, 9_000), "Actualizado hace 0 s");
});

test("sortHazards: alta primero, orden estable", () => {
  const list = [
    { id: "a", severity: "low" as const },
    { id: "b", severity: "high" as const },
    { id: "c", severity: "medium" as const },
    { id: "d", severity: "high" as const },
  ];
  assert.deepEqual(sortHazards(list).map((h) => h.id), ["b", "d", "c", "a"]);
});
