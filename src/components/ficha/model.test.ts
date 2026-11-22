import { test } from "node:test";
import assert from "node:assert/strict";
import type { SceneModel, SituationReport } from "@/lib/domain";
import type { LiveInsightView } from "@/lib/contract";
import { buildCards, buildDroneCards, buildMap, shortPlace, sourceChip, withDroneCards, type CriticalCard } from "./model";

const trapped = (status: SituationReport["trapped"]["status"], min = 1, max = 2): SituationReport["trapped"] => ({
  status,
  count_min: min,
  count_max: max,
  locations: ["V1, auto volcado sobre el techo, pista central: asiento del conductor"],
  basis: "",
  evidence: [
    { ref: "C5", frame: -1, note: "" },
    { ref: "M1", frame: 0, note: "" },
  ],
});

function situation(t: SituationReport["trapped"]): SituationReport {
  return {
    trapped: t,
    fire: { present: false, stage: "unknown", location: "", spread: "", smoke: "" },
    insights: [
      { id: "I1", category: "life_safety", priority: "critical", title: "Ocupante atrapado en V1", detail: "", confidence: "high", evidence: [] },
      { id: "I2", category: "vehicle", priority: "high", title: "V1 inestable", detail: "", confidence: "high", evidence: [] },
      { id: "I3", category: "hazard", priority: "high", title: "Derrame de combustible", detail: "", confidence: "high", evidence: [] },
      { id: "I4", category: "hazard", priority: "high", title: "Auto eléctrico", detail: "", confidence: "medium", evidence: [] },
    ],
    overall_confidence: "medium",
  } as unknown as SituationReport;
}

test("acorta lugares sin cortar en 'Av.'", () => {
  assert.equal(shortPlace("Av. Departamental con Av. Macul, Macul, Región Metropolitana", 1), "Av. Departamental con Av. Macul");
  assert.equal(shortPlace("V1, auto volcado sobre el techo, pista central: asiento"), "V1, auto volcado sobre el techo");
});

test("chips de fuente: cuadro en base 1", () => {
  assert.equal(sourceChip({ ref: "M1", frame: 0, note: "" }), "M1 · cuadro 1");
  assert.equal(sourceChip({ ref: "C5", frame: -1, note: "" }), "C5");
});

test("lo crítico: máximo 3 tarjetas, atrapados primero y sin duplicar el hallazgo", () => {
  const { cards, findings } = buildCards(situation(trapped("confirmed")), null, { analyzed: 2, total: 2 });
  assert.equal(cards.length, 3);
  assert.equal(cards[0].title, "1–2 personas atrapadas");
  assert.equal(cards[0].tone, "red");
  assert.equal(cards[0].confidence, "high");
  assert.deepEqual(cards[0].sources, ["C5", "M1 · cuadro 1"]);
  assert.ok(!cards.some((c) => c.title === "Ocupante atrapado en V1"));
  assert.equal(findings.length, 4);
});

test("sin evidencia de atrapados: 'no se ve', nunca 'no hay'", () => {
  const { cards } = buildCards(situation(trapped("no_evidence", 0, 0)), null, { analyzed: 2, total: 7 });
  assert.equal(cards[0].unseen, "No se ve en los videos · 2 de 7 analizados");
  for (const c of cards) assert.ok(!/no hay/i.test(`${c.title} ${c.unseen ?? ""}`));
});

test("mapa: vehículo con atrapamiento resaltado, zona de peligro y persona en rojo", () => {
  const scene = {
    structures: [],
    vehicles: [{ id: "V1", kind: "car", state: "overturned", x: 0, y: 0, rotation_deg: 90, length_m: 4.5, width_m: 1.8, entrapment_suspected: true, burning: false, note: "" }],
    people: [{ id: "P1", status: "trapped", count: 1, x: 0, y: 0, confidence: "high" }],
    hazards: [{ id: "H1", kind: "fuel_spill", x: 1, y: 0, radius_m: 5, severity: "high", note: "" }],
    fire_zones: [],
    cameras: [],
    access_points: [],
  } as unknown as SceneModel;
  const m = buildMap({ lat: -33.51, lng: -70.588, origin: "demo" }, scene, null, [], { arriving: false });
  assert.ok(m.parts.some((x) => x.color === "#F76B15"), "vehículo con atrapamiento en naranjo");
  assert.equal(m.zones[0].tone, "red");
  const p = m.pins.find((x) => x.id === "P1");
  assert.equal(p?.text, "1 persona atrapada");
  assert.equal(p?.sub, "confianza alta");
  assert.equal(m.halo?.tone, "red");
  const arriving = buildMap({ lat: -33.51, lng: -70.588, origin: "demo" }, scene, null, [], { arriving: true });
  assert.ok(!arriving.pins.some((x) => x.kind === "person"), "llegando: sin hallazgos en el mapa");
});

const NOW = Date.parse("2026-11-22T12:00:00Z");
const ins = (id: string, secAgo: number, severity: LiveInsightView["severity"], summary: string, extra: Partial<LiveInsightView> = {}): LiveInsightView => ({
  id,
  at: new Date(NOW - secAgo * 1000).toISOString(),
  summary,
  severity,
  changed: true,
  observations: [],
  engine: "claude",
  frames: 4,
  ...extra,
});
const card = (id: string, tone: CriticalCard["tone"] = "amber"): CriticalCard => ({
  id,
  tone,
  icon: "hazard",
  title: id,
  location: null,
  confidence: null,
  sources: [],
  unseen: null,
  focus: null,
});

test("dron en «Lo crítico»: la crítica y la advertencia más recientes, sin lo informativo ni lo viejo", () => {
  const cards = buildDroneCards(
    [
      ins("a", 20, "critical", "Persona en la ventana del 2º piso", { observations: ["Lado Bravo, agita los brazos"] }),
      ins("b", 50, "critical", "Persona en el techo"),
      ins("c", 10, "warning", "Humo negro saliendo por el techo"),
      ins("d", 5, "info", "Sin cambios"),
      ins("e", 600, "critical", "Llamas en la cocina"),
      ins("f", 2, "warning", "Fallo", { engine: "error" }),
    ],
    "D1",
    NOW,
    null,
  );
  assert.deepEqual(
    cards.map((c) => [c.id, c.tone, c.icon, c.title, c.location]),
    [
      ["D:a", "red", "person", "Persona en la ventana del 2º piso", "Lado Bravo, agita los brazos"],
      ["D:c", "amber", "fire", "Humo negro saliendo por el techo", null],
    ],
  );
  assert.deepEqual(cards[0].sources, ["Dron D1"]);
});

test("dron en «Lo crítico»: una advertencia más vieja que la crítica no se repite", () => {
  const cards = buildDroneCards([ins("a", 10, "critical", "Persona"), ins("b", 30, "warning", "Humo")], "D1", NOW, null);
  assert.deepEqual(cards.map((c) => c.id), ["D:a"]);
});

test("dron en «Lo crítico»: lo crítico del dron va después de atrapados y no se recorta", () => {
  const base = [card("trapped", "red"), card("fire", "orange"), card("I:x")];
  const merged = withDroneCards(base, [card("D:a", "red"), card("D:c")]);
  assert.deepEqual(merged.map((c) => c.id), ["trapped", "D:a", "fire", "D:c"]);
  assert.deepEqual(withDroneCards(base, []).map((c) => c.id), ["trapped", "fire", "I:x"]);
  assert.deepEqual(withDroneCards([card("I:x")], [card("D:a", "red")]).map((c) => c.id), ["D:a", "I:x"]);
});
