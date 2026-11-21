import { test } from "node:test";
import assert from "node:assert/strict";
import type { CommEntry } from "@/lib/domain";
import { simulateCommsAnalysis } from "./engine-simulated";
import { CLAVES_TEXT, claveByCode, expandClaves, findClaves, RADIO_CLAVES } from "./radio-claves";

test("el libro trae los grupos del instructivo sin claves repetidas", () => {
  const codes = RADIO_CLAVES.map((c) => c.code);
  assert.equal(new Set(codes).size, codes.length);
  assert.equal(claveByCode("6-7")?.meaning, "Situación controlada");
  assert.equal(claveByCode("1-2")?.meaning, "Se solicita al lugar: ambulancia SAMU");
  assert.equal(claveByCode("2-1")?.meaning, "Despache al lugar: carro porta escala (Q)");
  assert.equal(claveByCode("10-0-2")?.meaning, "Incendio de casa o local comercial menor");
  assert.match(CLAVES_TEXT, /6-19 Se informa bombero accidentado/);
});

test("findClaves: claves de 3 partes, sin confundir unidades ni claves desconocidas", () => {
  const hits = findClaves("Central a B-3: 10-0-2, 0-6. RX-15 6-3; clave 6-99 y 21-14.");
  assert.deepEqual(
    hits.map((h) => h.clave.code),
    ["10-0-2", "0-6", "6-3"],
  );
});

test("expandClaves agrega el significado en claro tras cada clave", () => {
  assert.equal(expandClaves("OBAC a Central: 6-7."), "OBAC a Central: 6-7 (Situación controlada).");
  assert.equal(expandClaves("Sin claves"), "Sin claves");
});

/** Tráfico de ejemplo (incendio en casa de dos pisos) con claves CBLA y sectores Alfa/Bravo/Charlie/Delta. */
const TRAFFIC: ReadonlyArray<readonly [speaker: string, channel: string, text: string]> = [
  ["Central", "5-1", "Central a B-3 y RX-4: 10-0-2, incendio de casa habitación de dos pisos. 0-6."],
  ["B-3", "5-1", "B-3 a Central: conforme, en camino con 6 bomberos."],
  ["B-3", "5-1", "B-3 6-3. Casa de dos pisos, fuego declarado en el segundo piso, sector Alfa. Humo negro denso por la techumbre."],
  ["B-3", "5-1", "B-3: 7-0, puesto de mando en sector Alfa, esquina norte. Teniente Rojas asume el mando como OBAC. Estrategia ofensiva."],
  ["Central", "5-1", "Central conforme. Unidades en la emergencia cambien a 5-2."],
  ["B-3", "5-2", "Vecinos informan adulto mayor atrapado en dormitorio del segundo piso, sector Charlie. Solicito 1-2 al lugar y 2-1."],
  ["Central", "5-2", "Central conforme: SAMU en camino. Se despacha Q-2."],
  ["RX-4", "5-2", "RX-4 6-3. Pareja con equipo autónomo ingresa por sector Bravo para búsqueda primaria en el segundo piso."],
  ["B-3", "5-2", "Fuego se propaga al entretecho de la vivienda colindante, sector Delta. Con peligro de propagación. B-1 trabajando en sector Delta, armado a grifo."],
  ["RX-4", "5-2", "RX-4: persona ubicada en sector Charlie, segundo piso. Consciente, con inhalación de humo. Evacuamos por la escala de Q-2."],
  ["Q-2", "5-2", "Q-2 6-3 en sector Charlie. Escala posicionada en ventana del segundo piso."],
  ["RX-4", "5-2", "RX-4: adulto mayor rescatado y entregado a SAMU en sector Alfa. Búsqueda primaria negativa, sin personas atrapadas."],
  ["B-3", "5-2", "Cilindro de gas licuado expuesto al calor en patio de sector Bravo. Se retira y se enfría."],
  ["B-3", "5-1", "OBAC a Central: 6-7. Propagación a sector Delta detenida, se mantiene remoción."],
  ["B-3", "5-1", "B-3: 6-17. B-1 6-9; quedan B-3 y RX-4 en remoción de escombros."],
];

function trafficEntries(): CommEntry[] {
  return TRAFFIC.map(([speaker, channel, text], i) => {
    const at = new Date(Date.UTC(2026, 10, 21, 15, 0, i * 15)).toISOString();
    return {
      id: `c${i + 1}`,
      incident_id: "inc-ej",
      seq: i + 1,
      at,
      channel,
      speaker,
      text,
      source: "dictation",
      audio_path: null,
      created_at: at,
    };
  });
}

test("un tráfico con claves y sectores alimenta el análisis de radio por reglas", () => {
  const all = trafficEntries();

  // A mitad del simulacro: atrapado informado, mando con puesto en sector Alfa, recursos pedidos.
  const mid = simulateCommsAnalysis({ incident: null as never, comms: all.slice(0, 8), previous: null, now: all[7].at });
  assert.equal(mid.victims.status, "reported");
  assert.equal(mid.command.established, true);
  assert.match(mid.command.post_location, /sector Alfa/);
  assert.ok(mid.resource_requests.length > 0, "1-2 / 2-1 quedan como solicitudes");
  assert.ok(
    mid.codes_interpreted.some((c) => c.code === "6-3" && c.certainty === "high"),
    "las claves del libro se interpretan con certeza alta",
  );
  assert.ok(!mid.codes_interpreted.some((c) => c.certainty === "low"), "ninguna clave queda como no verificada");
  assert.equal(mid.units.find((u) => u.name === "RX-4")?.status, "on_scene");

  // Al final: búsqueda primaria negativa, rescate, cilindro de gas y situación controlada.
  const end = simulateCommsAnalysis({ incident: null as never, comms: all, previous: null, now: all[all.length - 1].at });
  assert.ok(end.events.some((e) => e.kind === "all_clear" && /RX-4/.test(e.text)), "RX-4 en el lugar descarta atrapados");
  assert.ok(end.events.some((e) => e.kind === "victim_report" && /rescatado/.test(e.text)));
  assert.ok(end.hazards.some((h) => /gas/i.test(h)));
  assert.ok(end.events.some((e) => e.kind === "status_update" && /controlad/i.test(e.text)));
  assert.equal(end.units.find((u) => u.name === "B-1")?.status, "available");
});
