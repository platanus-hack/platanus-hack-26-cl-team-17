/**
 * Escena de ejemplo (incendio en casa de 2 pisos) para pruebas del visor.
 * Datos ficticios: no la uses como escena real.
 */
import type { SceneModel } from "@/lib/domain";

export const SAMPLE_SCENE: SceneModel = {
  description: "Casa de 2 pisos con fachada al sur hacia la calle; vecina expuesta al oriente.",
  ground: { street_axis_deg: 90, notes: "Calle residencial de doble sentido." },
  roads: [
    { id: "R1", name: "Av. Los Aromos", x1: -70, y1: -12, x2: 70, y2: -12, width_m: 8, blocked: false },
    { id: "R2", name: "Pasaje 3", x1: -20, y1: -12, x2: -20, y2: 40, width_m: 4, blocked: true },
  ],
  structures: [
    {
      id: "S1",
      label: "Casa afectada",
      kind: "house_2_story",
      role: "involved",
      x: 0,
      y: 0,
      width_m: 8,
      depth_m: 10,
      floors: 2,
      floor_height_m: 2.7,
      rotation_deg: 180,
      roof: "gable",
      construction: "masonry",
      confidence: "medium",
      notes: "Fachada de albañilería; segundo piso con ventanas al frente.",
    },
    {
      id: "S2",
      label: "",
      kind: "house_1_story",
      role: "exposure",
      x: 11,
      y: 0,
      width_m: 8,
      depth_m: 10,
      floors: 1,
      floor_height_m: 2.7,
      rotation_deg: 180,
      roof: "flat",
      construction: "wood",
      confidence: "low",
      notes: "",
    },
  ],
  fire_zones: [
    {
      id: "F1",
      structure_id: "S1",
      floor: 2,
      side: "rear",
      x: 0,
      y: 5,
      z: 4,
      radius_m: 3,
      intensity: "heavy",
      confidence: "medium",
      note: "Llamas por ventana posterior del 2º piso.",
    },
  ],
  smoke_plumes: [{ id: "H1", x: 0, y: 2, z: 7, drift_deg: 60, volume: "heavy", color: "black" }],
  people: [
    {
      id: "P1",
      status: "at_window_or_balcony",
      count: 1,
      structure_id: "S1",
      floor: 2,
      x: 1,
      y: -5,
      z: 3,
      confidence: "medium",
      note: "Persona pidiendo ayuda en la ventana del 2º piso.",
      evidence: [{ ref: "M1", frame: 3, note: "Silueta en la ventana" }],
    },
  ],
  vehicles: [],
  hazards: [
    { id: "Z1", kind: "gas_cylinder", x: 0, y: 8, z: 0, radius_m: 10, severity: "high", note: "Cilindros de 45 kg en el patio." },
  ],
  access_points: [
    { id: "A1", kind: "hydrant", x: -25, y: -16, label: "Grifo esquina", note: "A unos 30 m del frente." },
    { id: "A2", kind: "command_post", x: -35, y: -20, label: "", note: "" },
  ],
  cameras: [{ media_ref: "M1", x: 2, y: -25, z: 1.6, facing_deg: 0, confidence: "medium" }],
  annotations: [{ x: 0, y: -8, z: 0, text: "Antejardín con reja" }],
  uncertainty_notes: ["Profundidad de la casa supuesta en 10 m.", "Orientación inferida por la sombra de la calle."],
  confidence: "medium",
};
