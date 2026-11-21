/** Datos de prueba realistas para las pruebas del panel de comunicaciones (no se usa en la app). */
import { EMPTY_PIPELINE, type CommEntry, type CommsAnalysis, type PipelineState } from "@/lib/domain";

export const INCIDENT_ID = "inc_test_1";

function entry(seq: number, hhmmss: string, speaker: string, text: string, source: CommEntry["source"] = "manual"): CommEntry {
  const at = `2026-11-21T${hhmmss}.000Z`;
  return {
    id: `comm_${seq}`,
    incident_id: INCIDENT_ID,
    seq,
    at,
    channel: "Canal 1",
    speaker,
    text,
    source,
    audio_path: null,
    created_at: at,
  };
}

export const COMMS: CommEntry[] = [
  entry(1, "00:14:00", "Central", "B-3, Q-8 y RX-15 despachados a Av. Matta 1240, incendio en vivienda de dos pisos."),
  entry(2, "00:19:30", "B-3", "B-3 en el lugar. Vivienda de dos pisos, humo negro por ventanas del segundo piso."),
  entry(3, "00:20:10", "B-3", "Vecinos indican que podría haber una adulta mayor en el segundo piso.", "dictation"),
  entry(4, "00:22:00", "OBAC", "Solicito segunda alarma y una unidad de rescate adicional.", "import"),
  entry(5, "00:24:40", "B-3", "MAYDAY MAYDAY, bombero atrapado en escalera, segundo piso.", "simulated"),
];

export const ANALYSIS: CommsAnalysis = {
  summary: "Incendio estructural en vivienda de dos pisos con posible víctima en el segundo piso y un MAYDAY activo.",
  units: [
    { name: "B-3", status: "operating", last_report: "MAYDAY: bombero atrapado en escalera." },
    { name: "Q-8", status: "en_route", last_report: "En ruta." },
    { name: "RX-15", status: "unknown", last_report: "" },
  ],
  events: [
    { entry_seq: 2, kind: "arrival", text: "B-3 llega al lugar.", priority: "routine" },
    { entry_seq: 3, kind: "victim_report", text: "Posible adulta mayor en segundo piso.", priority: "critical" },
    { entry_seq: 4, kind: "resource_request", text: "Segunda alarma y rescate.", priority: "important" },
    { entry_seq: 5, kind: "mayday", text: "Bombero atrapado en escalera.", priority: "critical" },
  ],
  victims: { status: "reported", detail: "Posible adulta mayor en el segundo piso, según vecinos.", entry_seqs: [3] },
  mayday: { active: true, detail: "Bombero de B-3 atrapado en la escalera del segundo piso." },
  resource_requests: ["Segunda alarma", "Unidad de rescate adicional"],
  hazards: ["Escalera comprometida"],
  command: { established: true, commander: "OBAC", post_location: "Esquina Matta con Lira" },
  codes_interpreted: [
    { code: "10-0", meaning: "Incendio estructural", certainty: "high" },
    { code: "6-3", meaning: "Apoyo de otra compañía (no estándar en todos los Cuerpos)", certainty: "low" },
  ],
  open_questions: ["¿Cuántas personas viven en la casa?", "¿Hay acceso por la parte trasera?"],
};

export const PIPELINE_IDLE: PipelineState = { ...EMPTY_PIPELINE };
