/**
 * Vigía — contrato de dominio.
 *
 * Fuente única de verdad para las entidades persistidas y para los esquemas
 * de salida estructurada de la IA. Todo el resto del código (store, API, UI,
 * motores de IA) depende de este archivo; no dupliques estos tipos.
 *
 * Convenciones:
 *  - Identificadores y valores de enum en inglés (snake_case); todo texto libre
 *    que produce la IA o ve el usuario va en español de Chile.
 *  - Los esquemas `*AISchema` se envían a Claude como salida estructurada:
 *    todos los campos son obligatorios, sin restricciones numéricas ni de largo,
 *    sin recursión y con muy pocos `nullable`. "Desconocido" se expresa con el
 *    valor de enum `unknown`, string vacío, lista vacía o 0 según indique la
 *    descripción del campo.
 *  - Sistema de coordenadas local de la escena (ENU, metros): origen en la
 *    ubicación del incidente, x = Este, y = Norte, z = altura sobre el suelo.
 *    Rumbos en grados, 0 = Norte, en sentido horario (90 = Este).
 */
import { z } from "zod";

/* ════════════════════════════ Enumeraciones ════════════════════════════ */

export const IncidentTypeSchema = z.enum([
  "structure_fire",
  "vehicle_fire",
  "wildland_fire",
  "vehicle_collision",
  "hazmat",
  "rescue",
  "other",
  "unknown",
]);
export type IncidentType = z.infer<typeof IncidentTypeSchema>;

export const IncidentStatusSchema = z.enum(["active", "controlled", "closed"]);
export type IncidentStatus = z.infer<typeof IncidentStatusSchema>;

export const ConfidenceSchema = z.enum(["low", "medium", "high"]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const SeveritySchema = z.enum(["low", "moderate", "high", "critical"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const PrioritySchema = z.enum(["critical", "high", "medium", "low"]);
export type Priority = z.infer<typeof PrioritySchema>;

export const CardinalSchema = z.enum([
  "N",
  "NE",
  "E",
  "SE",
  "S",
  "SW",
  "W",
  "NW",
  "unknown",
]);
export type Cardinal = z.infer<typeof CardinalSchema>;

/**
 * Estado de la pregunta más importante del puesto de mando.
 * Nunca existe "descartado por la IA": la ausencia de evidencia en video no
 * descarta víctimas. Solo una unidad en el lugar puede declararlo
 * (`cleared_by_unit`), y eso llega por comunicaciones.
 */
export const TrappedStatusSchema = z.enum([
  "confirmed",
  "probable",
  "possible",
  "no_evidence",
  "cleared_by_unit",
]);
export type TrappedStatus = z.infer<typeof TrappedStatusSchema>;

export const LikelihoodSchema = z.enum([
  "confirmed",
  "probable",
  "possible",
  "no_evidence",
]);
export type Likelihood = z.infer<typeof LikelihoodSchema>;

export const StructureKindSchema = z.enum([
  "house_1_story",
  "house_2_story",
  "apartment_building",
  "commercial",
  "industrial",
  "warehouse",
  "informal_settlement",
  "other",
  "unknown",
]);
export type StructureKind = z.infer<typeof StructureKindSchema>;

export const ConstructionSchema = z.enum([
  "wood",
  "masonry",
  "concrete",
  "metal",
  "light_materials",
  "mixed",
  "unknown",
]);
export type Construction = z.infer<typeof ConstructionSchema>;

export const FireStageSchema = z.enum([
  "none",
  "incipient",
  "growth",
  "fully_developed",
  "decay",
  "unknown",
]);
export type FireStage = z.infer<typeof FireStageSchema>;

export const StructureSideSchema = z.enum([
  "front",
  "rear",
  "left",
  "right",
  "roof",
  "interior",
  "whole_floor",
  "unknown",
]);
export type StructureSide = z.infer<typeof StructureSideSchema>;

export const SmokeColorSchema = z.enum([
  "none",
  "white",
  "gray",
  "black",
  "brown",
  "yellow",
  "unknown",
]);
export type SmokeColor = z.infer<typeof SmokeColorSchema>;

export const SmokeVolumeSchema = z.enum(["none", "light", "moderate", "heavy"]);
export type SmokeVolume = z.infer<typeof SmokeVolumeSchema>;

export const PersonStatusSchema = z.enum([
  "trapped",
  "at_window_or_balcony",
  "on_roof",
  "injured",
  "evacuating",
  "bystander",
  "responder",
  "unknown",
]);
export type PersonStatus = z.infer<typeof PersonStatusSchema>;

export const VehicleKindSchema = z.enum([
  "car",
  "suv_pickup",
  "van",
  "truck",
  "bus",
  "motorcycle",
  "bicycle",
  "trailer",
  "other",
]);
export type VehicleKind = z.infer<typeof VehicleKindSchema>;

export const VehicleStateSchema = z.enum([
  "upright",
  "on_side",
  "overturned",
  "crushed",
  "burning",
  "unknown",
]);
export type VehicleState = z.infer<typeof VehicleStateSchema>;

export const DamageSchema = z.enum(["minor", "moderate", "severe", "unknown"]);
export type Damage = z.infer<typeof DamageSchema>;

export const HazardKindSchema = z.enum([
  "gas_cylinder",
  "gas_line",
  "power_lines",
  "electrical",
  "fuel_spill",
  "hazmat_placard",
  "collapse_risk",
  "explosion_risk",
  "ev_battery",
  "solar_panels",
  "traffic",
  "crowd",
  "water_hazard",
  "other",
]);
export type HazardKind = z.infer<typeof HazardKindSchema>;

export const HazardSeveritySchema = z.enum(["low", "medium", "high"]);
export type HazardSeverity = z.infer<typeof HazardSeveritySchema>;

export const AnalysisEngineSchema = z.enum(["claude", "simulated"]);
/** `simulated` = sin ANTHROPIC_API_KEY: resultados de demostración, nunca evidencia real. */
export type AnalysisEngine = z.infer<typeof AnalysisEngineSchema>;

/* ═══════════════════════ Referencias a la evidencia ═══════════════════════ */

/**
 * Referencia compacta a la evidencia que respalda una afirmación.
 * `ref` usa las etiquetas visibles en el puesto de mando:
 *   "M3"  → medio (video/fotos de vecino o dron) con label M3
 *   "C12" → entrada de comunicaciones con seq 12
 */
export const EvidenceRefSchema = z.object({
  ref: z
    .string()
    .describe(
      'Etiqueta de la fuente: "M<n>" para un medio (video/fotos/dron) o "C<n>" para una entrada de comunicaciones. Usa solo etiquetas que aparezcan en la entrada.',
    ),
  frame: z
    .number()
    .describe(
      "Índice del fotograma dentro del medio (0 = primero) o -1 si no aplica (comunicaciones o nota del vecino).",
    ),
  note: z
    .string()
    .describe("Qué se ve u oye exactamente en esa fuente, en una frase corta."),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

/* ═══════════════ IA · análisis de un medio (video/fotos/dron) ═══════════════ */

export const MediaAnalysisAISchema = z.object({
  usable: z
    .boolean()
    .describe(
      "false si los fotogramas no muestran la emergencia o no permiten extraer información (oscuros, borrosos, irrelevantes).",
    ),
  unusable_reason: z.string().describe("Motivo si usable=false; vacío si usable=true."),
  incident_type: IncidentTypeSchema.describe("Tipo de emergencia que muestran las imágenes."),
  summary: z
    .string()
    .describe("Resumen factual de lo que se ve, 1 a 3 frases, sin especular."),
  viewpoint: z.object({
    position_description: z
      .string()
      .describe('Desde dónde se grabó, p. ej. "vereda de enfrente, lado sur de la calle".'),
    facing: CardinalSchema.describe(
      "Hacia dónde apunta la cámara. Usa el rumbo de brújula entregado en los metadatos si existe; si no, 'unknown'.",
    ),
    distance_m: z
      .number()
      .describe("Distancia estimada de la cámara al foco del incidente en metros; 0 si no se puede estimar."),
    elevation: z.enum(["ground", "elevated", "aerial", "interior", "unknown"]),
  }),
  structure: z.object({
    present: z.boolean().describe("Hay una edificación involucrada o directamente amenazada."),
    kind: StructureKindSchema,
    floors_visible: z.number().describe("Número de pisos visibles; 0 si no se puede determinar."),
    construction: ConstructionSchema,
    exposures: z
      .string()
      .describe("Edificaciones o elementos vecinos en riesgo de propagación; vacío si no se observan."),
    description: z.string(),
  }),
  fire: z.object({
    present: z.boolean(),
    stage: FireStageSchema,
    flames_visible: z.boolean(),
    locations: z
      .array(
        z.object({
          floor: z.number().describe("Piso donde se ve fuego (1 = nivel calle); 0 si no se puede determinar."),
          side: StructureSideSchema.describe(
            "Costado respecto de la fachada principal vista desde la calle (front = fachada).",
          ),
          description: z.string(),
        }),
      )
      .describe("Focos de fuego visibles; lista vacía si no hay."),
    smoke: z.object({
      present: z.boolean(),
      color: SmokeColorSchema,
      volume: SmokeVolumeSchema,
      description: z.string(),
    }),
    spread_risk: z.enum(["low", "moderate", "high", "unknown"]),
  }),
  people: z
    .array(
      z.object({
        status: PersonStatusSchema,
        count: z.number().describe("Cantidad de personas en este grupo (mínimo observable)."),
        location: z.string().describe('Dónde están, p. ej. "ventana del 2º piso, costado izquierdo".'),
        floor: z.number().describe("Piso (1 = nivel calle); 0 si no aplica o no se sabe."),
        frame_refs: z.array(z.number()).describe("Índices de fotogramas donde se observan."),
        confidence: ConfidenceSchema,
        description: z.string(),
      }),
    )
    .describe(
      "Personas relevantes para la emergencia. No listes transeúntes uno por uno: agrúpalos como 'bystander'.",
    ),
  vehicles: z
    .array(
      z.object({
        kind: VehicleKindSchema,
        state: VehicleStateSchema,
        damage: DamageSchema,
        occupants_visible: z.enum(["yes", "no", "unknown"]),
        entrapment_suspected: z
          .boolean()
          .describe("Deformación del habitáculo u otra señal de que puede haber ocupantes atrapados."),
        leaking_fluids: z.boolean(),
        position: z.string().describe("Ubicación y orientación respecto de la vía."),
        description: z.string(),
        frame_refs: z.array(z.number()),
      }),
    )
    .describe("Vehículos involucrados en la emergencia (no los estacionados sin relación)."),
  hazards: z.array(
    z.object({
      kind: HazardKindSchema,
      description: z.string(),
      severity: HazardSeveritySchema,
      frame_refs: z.array(z.number()),
    }),
  ),
  access: z.object({
    description: z.string().describe("Cómo se llega al foco: calles, pasajes, portones, ancho aparente."),
    obstructions: z.array(z.string()).describe("Obstáculos para carros y personal."),
    water_sources: z.array(z.string()).describe("Grifos, piscinas u otras fuentes de agua visibles."),
  }),
  key_frames: z
    .array(
      z.object({
        frame: z.number().describe("Índice del fotograma."),
        caption: z.string().describe("Qué muestra y por qué importa."),
      }),
    )
    .describe("Los 1 a 4 fotogramas más informativos."),
  visible_text: z
    .array(z.string())
    .describe("Texto legible útil: numeración, nombres de calles, letreros, rombos de materiales peligrosos."),
  uncertainties: z.array(z.string()).describe("Lo que no se puede determinar con estas imágenes."),
  confidence: ConfidenceSchema.describe("Confianza global del análisis de este medio."),
});
export type MediaAnalysis = z.infer<typeof MediaAnalysisAISchema>;

/* ═══════════════════ IA · análisis de comunicaciones ═══════════════════ */

export const UnitStatusSchema = z.enum([
  "dispatched",
  "en_route",
  "on_scene",
  "operating",
  "available",
  "unknown",
]);
export type UnitStatus = z.infer<typeof UnitStatusSchema>;

export const CommEventKindSchema = z.enum([
  "dispatch",
  "arrival",
  "size_up",
  "victim_report",
  "mayday",
  "resource_request",
  "hazard",
  "order",
  "status_update",
  "all_clear",
  "other",
]);
export type CommEventKind = z.infer<typeof CommEventKindSchema>;

export const CommsAnalysisAISchema = z.object({
  summary: z.string().describe("Estado de la emergencia según el tráfico radial, 1 a 3 frases."),
  units: z.array(
    z.object({
      name: z.string().describe('Identificador tal como se usa en radio, p. ej. "B-3", "RX-15", "Q-8".'),
      status: UnitStatusSchema,
      last_report: z.string(),
    }),
  ),
  events: z
    .array(
      z.object({
        entry_seq: z.number().describe("Número (seq) de la entrada de comunicaciones de origen."),
        kind: CommEventKindSchema,
        text: z.string().describe("Hecho extraído, redactado en claro."),
        priority: z.enum(["routine", "important", "critical"]),
      }),
    )
    .describe("Hechos operacionalmente relevantes, en orden cronológico."),
  victims: z.object({
    status: z
      .enum(["reported", "denied_by_unit", "unknown"])
      .describe(
        "reported = alguien informa personas atrapadas/lesionadas; denied_by_unit = una unidad EN EL LUGAR informa que no hay; unknown = no se ha dicho nada.",
      ),
    detail: z.string(),
    entry_seqs: z.array(z.number()),
  }),
  mayday: z.object({
    active: z.boolean().describe("Hay una emergencia de bombero (mayday / bombero en peligro) sin resolver."),
    detail: z.string(),
  }),
  resource_requests: z.array(z.string()).describe("Recursos solicitados y aún no confirmados en el lugar."),
  hazards: z.array(z.string()),
  command: z.object({
    established: z.boolean(),
    commander: z.string().describe("Quién está al mando según radio; vacío si no se ha dicho."),
    post_location: z.string(),
  }),
  codes_interpreted: z
    .array(
      z.object({
        code: z.string(),
        meaning: z.string(),
        certainty: ConfidenceSchema,
      }),
    )
    .describe(
      "Claves radiales usadas y cómo se interpretaron. Las claves varían entre Cuerpos de Bomberos: marca certainty=low si no estás seguro.",
    ),
  open_questions: z.array(z.string()).describe("Información que el mando debería pedir por radio."),
});
export type CommsAnalysis = z.infer<typeof CommsAnalysisAISchema>;

/* ═══════════════ IA · informe de situación (fusión de fuentes) ═══════════════ */

export const InsightCategorySchema = z.enum([
  "life_safety",
  "fire_behavior",
  "structure",
  "vehicle",
  "hazard",
  "access",
  "resources",
  "other",
]);
export type InsightCategory = z.infer<typeof InsightCategorySchema>;

export const SituationReportAISchema = z.object({
  headline: z
    .string()
    .describe(
      'Una línea que un oficial pueda leer en 3 segundos, p. ej. "Casa de 2 pisos con fuego en 2º piso; posible persona atrapada en ventana".',
    ),
  incident_type: IncidentTypeSchema,
  severity: SeveritySchema,
  trapped: z.object({
    status: TrappedStatusSchema.describe(
      "confirmed = se ve o lo informa una unidad en el lugar; probable = evidencia fuerte de una fuente; possible = indicios o reporte de vecino sin corroborar; no_evidence = nada lo indica (NO equivale a descartar); cleared_by_unit = solo si una unidad en el lugar lo informó por radio.",
    ),
    count_min: z.number().describe("Mínimo de personas atrapadas respaldado por evidencia; 0 si ninguna."),
    count_max: z.number().describe("Máximo plausible; igual a count_min si no hay rango."),
    locations: z.array(z.string()),
    basis: z.string().describe("Por qué se asigna este estado, citando las fuentes."),
    evidence: z.array(EvidenceRefSchema),
  }),
  injured: z.object({
    status: LikelihoodSchema,
    count_estimate: z.number().describe("Estimación de lesionados visibles o informados; 0 si ninguno."),
    detail: z.string(),
  }),
  fire: z.object({
    present: z.boolean(),
    stage: FireStageSchema,
    location: z.string(),
    spread: z.string().describe("Hacia dónde puede propagarse y qué está expuesto."),
    smoke: z.string(),
  }),
  structure: z.object({
    description: z.string(),
    floors: z.number().describe("Pisos de la edificación principal; 0 si no aplica o no se sabe."),
    construction: ConstructionSchema,
    exposures: z.string(),
  }),
  vehicles: z.object({
    count: z.number(),
    description: z.string(),
    entrapment: LikelihoodSchema,
    details: z.string().describe("Estado de cada vehículo, fluidos, energía (eléctrico/híbrido si se distingue)."),
  }),
  hazards: z.array(
    z.object({
      kind: HazardKindSchema,
      description: z.string(),
      severity: HazardSeveritySchema,
      evidence: z.array(EvidenceRefSchema),
    }),
  ),
  access: z.object({
    best_approach: z.string().describe("Por dónde conviene llegar y posicionar el primer carro."),
    obstructions: z.array(z.string()),
    water_supply: z.string(),
    staging_suggestion: z.string(),
  }),
  insights: z
    .array(
      z.object({
        id: z.string().describe('Identificador corto y estable, p. ej. "I1".'),
        category: InsightCategorySchema,
        priority: PrioritySchema,
        title: z.string(),
        detail: z.string(),
        confidence: ConfidenceSchema,
        evidence: z.array(EvidenceRefSchema),
      }),
    )
    .describe("Hallazgos accionables ordenados de mayor a menor prioridad (máx. 10)."),
  contradictions: z
    .array(
      z.object({
        description: z.string(),
        sources: z.array(z.string()).describe('Etiquetas de las fuentes en conflicto, p. ej. ["M2","C7"].'),
      }),
    )
    .describe("Fuentes que se contradicen entre sí (video vs. video, video vs. radio)."),
  unknowns: z
    .array(z.string())
    .describe("Lo que NO se sabe y conviene confirmar antes o al llegar."),
  recommended_actions: z
    .array(
      z.object({
        action: z.string(),
        rationale: z.string(),
        priority: PrioritySchema,
      }),
    )
    .describe(
      "Consideraciones tácticas de apoyo a la decisión (máx. 6). Son sugerencias; la decisión es del oficial a cargo.",
    ),
  briefing: z.object({
    spoken: z
      .string()
      .describe(
        "Texto corrido de hasta 90 palabras para leer en voz alta a las unidades en ruta: qué es, dónde, vidas en riesgo, peligros, acceso. Sin abreviaturas difíciles de pronunciar.",
      ),
    bullets: z.array(z.string()).describe("5 a 8 puntos telegráficos para pantalla."),
  }),
  overall_confidence: ConfidenceSchema,
});
export type SituationReport = z.infer<typeof SituationReportAISchema>;

/* ═══════════════════ IA · reconstrucción espacial (escena) ═══════════════════ */

export const AccessPointKindSchema = z.enum([
  "door",
  "gate",
  "window",
  "stairwell",
  "street_entry",
  "hydrant",
  "staging",
  "command_post",
  "other",
]);
export type AccessPointKind = z.infer<typeof AccessPointKindSchema>;

export const SceneModelAISchema = z.object({
  description: z.string().describe("Descripción breve de la disposición espacial reconstruida."),
  ground: z.object({
    street_axis_deg: z
      .number()
      .describe("Rumbo del eje de la calle principal (0-179, 0 = Norte-Sur, 90 = Este-Oeste); -1 si se desconoce."),
    notes: z.string(),
  }),
  roads: z.array(
    z.object({
      id: z.string(),
      name: z.string().describe("Nombre de la vía si se conoce; vacío si no."),
      x1: z.number(),
      y1: z.number(),
      x2: z.number(),
      y2: z.number(),
      width_m: z.number(),
      blocked: z.boolean().describe("La vía está obstruida para carros bomba."),
    }),
  ),
  structures: z.array(
    z.object({
      id: z.string().describe('Identificador, p. ej. "S1".'),
      label: z.string(),
      kind: StructureKindSchema,
      role: z.enum(["involved", "exposure", "reference"]),
      x: z.number().describe("Centro de la planta, metros al Este del origen."),
      y: z.number().describe("Centro de la planta, metros al Norte del origen."),
      width_m: z.number().describe("Largo de la fachada principal."),
      depth_m: z.number(),
      floors: z.number(),
      floor_height_m: z.number().describe("Altura de piso; usa 2.7 si no hay mejor dato."),
      rotation_deg: z
        .number()
        .describe("Rumbo hacia el que mira la fachada principal (0 = Norte, 90 = Este)."),
      roof: z.enum(["flat", "gable", "unknown"]),
      construction: ConstructionSchema,
      confidence: ConfidenceSchema,
      notes: z.string(),
    }),
  ),
  fire_zones: z.array(
    z.object({
      id: z.string(),
      structure_id: z.string().describe("Estructura donde está el foco; vacío si es exterior o vehículo."),
      floor: z.number().describe("Piso (1 = nivel calle); 0 si es exterior."),
      side: StructureSideSchema,
      x: z.number(),
      y: z.number(),
      z: z.number().describe("Altura del centro del foco sobre el suelo, en metros."),
      radius_m: z.number(),
      intensity: z.enum(["smoke_only", "light", "moderate", "heavy"]),
      confidence: ConfidenceSchema,
      note: z.string(),
    }),
  ),
  smoke_plumes: z.array(
    z.object({
      id: z.string(),
      x: z.number(),
      y: z.number(),
      z: z.number(),
      drift_deg: z.number().describe("Rumbo hacia donde deriva el humo; -1 si se desconoce."),
      volume: SmokeVolumeSchema,
      color: SmokeColorSchema,
    }),
  ),
  people: z.array(
    z.object({
      id: z.string(),
      status: PersonStatusSchema,
      count: z.number(),
      structure_id: z.string().describe("Estructura asociada; vacío si están en el exterior."),
      floor: z.number(),
      x: z.number(),
      y: z.number(),
      z: z.number(),
      confidence: ConfidenceSchema,
      note: z.string(),
      evidence: z.array(EvidenceRefSchema),
    }),
  ),
  vehicles: z.array(
    z.object({
      id: z.string(),
      kind: VehicleKindSchema,
      state: VehicleStateSchema,
      x: z.number(),
      y: z.number(),
      rotation_deg: z.number().describe("Rumbo hacia el que apunta el frente del vehículo."),
      length_m: z.number(),
      width_m: z.number(),
      entrapment_suspected: z.boolean(),
      burning: z.boolean(),
      note: z.string(),
    }),
  ),
  hazards: z.array(
    z.object({
      id: z.string(),
      kind: HazardKindSchema,
      x: z.number(),
      y: z.number(),
      z: z.number(),
      radius_m: z.number().describe("Radio de la zona de riesgo o exclusión sugerida."),
      severity: HazardSeveritySchema,
      note: z.string(),
    }),
  ),
  access_points: z.array(
    z.object({
      id: z.string(),
      kind: AccessPointKindSchema,
      x: z.number(),
      y: z.number(),
      label: z.string(),
      note: z.string(),
    }),
  ),
  cameras: z
    .array(
      z.object({
        media_ref: z.string().describe('Etiqueta del medio, p. ej. "M2".'),
        x: z.number(),
        y: z.number(),
        z: z.number(),
        facing_deg: z.number().describe("Rumbo hacia el que mira la cámara; -1 si se desconoce."),
        confidence: ConfidenceSchema,
      }),
    )
    .describe(
      "Posición estimada desde donde se grabó cada medio. Si la entrada trae posición GPS convertida a coordenadas locales, úsala tal cual.",
    ),
  annotations: z.array(
    z.object({
      x: z.number(),
      y: z.number(),
      z: z.number(),
      text: z.string(),
    }),
  ),
  uncertainty_notes: z
    .array(z.string())
    .describe("Supuestos geométricos hechos para poder dibujar la escena (dimensiones asumidas, orientación inferida, etc.)."),
  confidence: ConfidenceSchema,
});
export type SceneModel = z.infer<typeof SceneModelAISchema>;

/* ═══════════════════════════ Entidades persistidas ═══════════════════════════ */

/* ═══════════════ Reconstrucción fotogramétrica (3D Gaussian Splatting) ═══════════════ */

/**
 * Reconstrucción 3D real de la escena a partir de TODOS los videos/cuadros del
 * incidente (vecinos + dron), entrenada con 3D Gaussian Splatting en un job de
 * Cloud Run con GPU. Complementa (no reemplaza) la escena esquemática de la IA.
 */
export const ReconstructionStatusSchema = z.enum([
  "queued",
  "preparing",
  "posing",
  "training",
  "exporting",
  "ready",
  "failed",
]);
export type ReconstructionStatus = z.infer<typeof ReconstructionStatusSchema>;

export interface Reconstruction {
  id: string;
  status: ReconstructionStatus;
  /** 0..1 */
  progress: number;
  /** Estado legible en español ("Estimando cámaras de 84 cuadros…"). */
  message: string;
  method: "gaussian_splatting";
  /** Dónde se entrenó. "demo" = archivo de demostración, no viene de los videos del incidente. */
  backend: "cloud_run_gpu" | "demo";
  /** Tipo de GPU usada, p. ej. "nvidia-rtx-pro-6000". */
  gpu: string | null;
  /** Medios usados como entrada. */
  media_ids: string[];
  /** Cuadros que entraron a la estimación de cámaras / entrenamiento. */
  frame_count: number;
  /** Cuadros cuyas cámaras se pudieron estimar. */
  frames_registered: number | null;
  /** Ruta del archivo de splats en el storage (formato `splat_format`). */
  splat_path: string | null;
  splat_format: "splat" | "ply" | "spz" | null;
  /**
   * Matriz 4×4 (16 números, fila por fila) que lleva coordenadas del archivo de
   * splats al sistema local de la escena: ENU en metros con origen en el incidente
   * (x Este, y Norte, z arriba). null = sin alinear.
   */
  transform: number[] | null;
  /** gps = alineada con posiciones GPS de cámaras (dron/teléfonos); approximate = orientación vertical y escala estimadas; none = sin alinear. */
  alignment: "gps" | "approximate" | "none";
  /** false si la escala métrica no se pudo determinar (el visor lo advierte). */
  scale_known: boolean;
  gaussians: number | null;
  iterations: number | null;
  /** Segundos de GPU usados (para costo). */
  gpu_seconds: number | null;
  error: string | null;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export type PipelineStatus = "idle" | "pending" | "running" | "error";

/** Estado del pipeline de fusión por incidente (lo muestra el puesto de mando). */
export interface PipelineState {
  fusion_status: PipelineStatus;
  fusion_error: string | null;
  /** Se marca cada vez que entra información nueva; la fusión corre mientras sea posterior a fusion_started_at. */
  fusion_requested_at: string | null;
  fusion_started_at: string | null;
  fusion_finished_at: string | null;
  comms_status: PipelineStatus;
  comms_error: string | null;
  comms_requested_at: string | null;
  comms_finished_at: string | null;
}

export const EMPTY_PIPELINE: PipelineState = {
  fusion_status: "idle",
  fusion_error: null,
  fusion_requested_at: null,
  fusion_started_at: null,
  fusion_finished_at: null,
  comms_status: "idle",
  comms_error: null,
  comms_requested_at: null,
  comms_finished_at: null,
};

export interface Incident {
  id: string;
  /** Código corto para vecinos y QR, p. ej. "VG-7K3Q". Único. */
  code: string;
  type: IncidentType;
  title: string;
  address: string;
  lat: number;
  lng: number;
  status: IncidentStatus;
  description: string;
  /** "command" = creado por la central; "citizen" = nació de un reporte de vecino. */
  origin: "command" | "citizen" | "demo";
  /** Los incidentes creados por vecinos parten sin verificar hasta que el mando los confirma. */
  verified: boolean;
  /** Secreto de solo lectura para el enlace de briefing en ruta. */
  share_key: string;
  /** Contador que aumenta con cualquier cambio del incidente o de sus hijos (sondeo barato). */
  rev: number;
  situation: SituationReport | null;
  situation_engine: AnalysisEngine | null;
  situation_updated_at: string | null;
  scene: SceneModel | null;
  scene_engine: AnalysisEngine | null;
  scene_updated_at: string | null;
  comms_analysis: CommsAnalysis | null;
  comms_engine: AnalysisEngine | null;
  comms_analysis_updated_at: string | null;
  pipeline: PipelineState;
  /** Última reconstrucción 3DGS del incidente (opcional: los stores antiguos no la traen). */
  reconstruction?: Reconstruction | null;
  created_at: string;
  updated_at: string;
}

export type MediaSource = "citizen" | "drone" | "responder" | "demo";
export type MediaKind = "video" | "photo" | "frames";
export type MediaStatus = "uploading" | "uploaded" | "analyzing" | "analyzed" | "failed";

export interface MediaFrame {
  id: string;
  media_id: string;
  /** Índice dentro del medio, desde 0; es el índice que cita la IA. */
  idx: number;
  /** Segundo del video del que se extrajo (0 para fotos). */
  t_s: number;
  storage_path: string;
  width: number;
  height: number;
  /** Solo para cuadros de dron: posición al capturar. */
  lat: number | null;
  lng: number | null;
  alt_m: number | null;
  heading_deg: number | null;
}

export interface Media {
  id: string;
  incident_id: string;
  /** Etiqueta secuencial por incidente: "M1", "M2"... */
  label: string;
  source: MediaSource;
  kind: MediaKind;
  mission_id: string | null;
  /** Ruta del video original en el storage; null si solo hay fotogramas o aún no termina de subir. */
  video_path: string | null;
  video_status: "none" | "uploading" | "uploaded" | "failed";
  mime: string | null;
  size_bytes: number | null;
  duration_s: number | null;
  lat: number | null;
  lng: number | null;
  accuracy_m: number | null;
  /** Rumbo de brújula del teléfono al grabar, si el navegador lo entregó. */
  heading_deg: number | null;
  captured_at: string | null;
  reporter_note: string;
  status: MediaStatus;
  error: string | null;
  analysis: MediaAnalysis | null;
  analysis_engine: AnalysisEngine | null;
  analyzed_at: string | null;
  frames: MediaFrame[];
  created_at: string;
}

export type CommSource = "manual" | "dictation" | "simulated" | "import";

export interface CommEntry {
  id: string;
  incident_id: string;
  /** Número secuencial por incidente; la IA lo cita como "C<seq>". */
  seq: number;
  at: string;
  channel: string;
  speaker: string;
  text: string;
  source: CommSource;
  created_at: string;
}

export type MissionStatus =
  | "planned"
  | "launching"
  | "en_route"
  | "on_station"
  | "returning"
  | "landed"
  | "aborted";
export type MissionPattern = "orbit" | "hover" | "grid";
/** simulated = telemetría generada por la plataforma; device = teléfono/sensor web; api = dron real vía API. */
export type MissionMode = "simulated" | "device" | "api";

export interface TelemetryPoint {
  at: string;
  lat: number;
  lng: number;
  alt_m: number;
  heading_deg: number;
  speed_ms: number | null;
  battery_pct: number | null;
}

export interface DroneMission {
  id: string;
  incident_id: string;
  /** "D1", "D2"... */
  label: string;
  status: MissionStatus;
  mode: MissionMode;
  pattern: MissionPattern;
  radius_m: number;
  altitude_m: number;
  speed_ms: number;
  home_lat: number;
  home_lng: number;
  waypoints: { lat: number; lng: number; alt_m: number }[];
  /** Orden pendiente que el dron recibe en la respuesta de telemetría. */
  command: "continue" | "recall" | "abort";
  last: TelemetryPoint | null;
  /** Traza reciente (acotada a los últimos ~300 puntos). */
  track: TelemetryPoint[];
  frames_received: number;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

export type TimelineKind =
  | "incident_created"
  | "incident_updated"
  | "media_received"
  | "media_analyzed"
  | "media_failed"
  | "alert"
  | "situation_updated"
  | "scene_updated"
  | "comms"
  | "comms_alert"
  | "drone"
  | "error";
export type TimelineSeverity = "info" | "notice" | "warning" | "critical";

export interface TimelineEvent {
  id: string;
  incident_id: string;
  at: string;
  kind: TimelineKind;
  severity: TimelineSeverity;
  title: string;
  detail: string;
  media_id: string | null;
  comm_id: string | null;
  mission_id: string | null;
}

/* ═══════════════════════════ Entradas validadas ═══════════════════════════ */

export const CreateIncidentInputSchema = z.object({
  type: IncidentTypeSchema,
  title: z.string().trim().max(140).optional(),
  address: z.string().trim().max(240).default(""),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  description: z.string().trim().max(2000).default(""),
});
export type CreateIncidentInput = z.infer<typeof CreateIncidentInputSchema>;

export const UpdateIncidentInputSchema = z.object({
  type: IncidentTypeSchema.optional(),
  title: z.string().trim().min(1).max(140).optional(),
  address: z.string().trim().max(240).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  description: z.string().trim().max(2000).optional(),
  status: IncidentStatusSchema.optional(),
  verified: z.boolean().optional(),
});
export type UpdateIncidentInput = z.infer<typeof UpdateIncidentInputSchema>;

export const FrameMetaSchema = z.object({
  idx: z.number().int().min(0).max(63),
  t_s: z.number().min(0),
  width: z.number().int().min(1).max(8000),
  height: z.number().int().min(1).max(8000),
});
export type FrameMeta = z.infer<typeof FrameMetaSchema>;

/** Límites del flujo ciudadano (también los aplica el servidor). */
export const LIMITS = {
  MAX_FRAMES_PER_MEDIA: 12,
  FRAME_LONG_EDGE_PX: 1280,
  FRAME_JPEG_QUALITY: 0.82,
  MAX_FRAME_BYTES: 3_000_000,
  /** Tope del video original; el análisis no depende de él (se analiza con fotogramas). */
  MAX_VIDEO_BYTES: 250 * 1024 * 1024,
  MAX_NOTE_CHARS: 600,
  /** Un reporte sin código se une a un incidente activo si está a menos de esta distancia. */
  AUTO_ATTACH_RADIUS_M: 250,
  NEARBY_RADIUS_M: 3000,
  DRONE_BATCH_FRAMES: 6,
  /** Máximo de cuadros que entran a una reconstrucción 3DGS (la GPU de 96 GB aguanta ~200 a 518 px). */
  SPLAT_MAX_FRAMES: 160,
  /** Cuadros por segundo al muestrear los videos originales para la reconstrucción. */
  SPLAT_SAMPLE_FPS: 3,
} as const;

export const CreateReportInputSchema = z.object({
  /** Código del incidente (QR/enlace). Si falta, se busca un incidente cercano o se crea uno sin verificar. */
  incident_code: z.string().trim().max(16).optional(),
  /** Tipo que el vecino cree que es; se usa solo si hay que crear un incidente nuevo. */
  type_hint: IncidentTypeSchema.optional(),
  kind: z.enum(["video", "photo"]),
  mime: z.string().max(120),
  size_bytes: z.number().int().min(0),
  duration_s: z.number().min(0).nullable(),
  lat: z.number().min(-90).max(90).nullable(),
  lng: z.number().min(-180).max(180).nullable(),
  accuracy_m: z.number().min(0).nullable(),
  heading_deg: z.number().min(0).max(360).nullable(),
  captured_at: z.string().datetime().nullable(),
  note: z.string().trim().max(LIMITS.MAX_NOTE_CHARS).default(""),
  frames: z.array(FrameMetaSchema).max(LIMITS.MAX_FRAMES_PER_MEDIA),
  /** true si el cliente además subirá el video original. */
  upload_video: z.boolean(),
  /** Solo se respeta si quien llama tiene sesión de personal: registra el medio como source "responder". */
  as_responder: z.boolean().optional(),
});
export type CreateReportInput = z.infer<typeof CreateReportInputSchema>;

export const AddCommInputSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  speaker: z.string().trim().max(60).default(""),
  channel: z.string().trim().max(40).default(""),
  source: z.enum(["manual", "dictation", "simulated", "import"]).default("manual"),
  at: z.string().datetime().optional(),
});
export type AddCommInput = z.infer<typeof AddCommInputSchema>;

export const CreateMissionInputSchema = z.object({
  mode: z.enum(["simulated", "device", "api"]),
  pattern: z.enum(["orbit", "hover", "grid"]).default("orbit"),
  radius_m: z.number().min(10).max(500).default(60),
  altitude_m: z.number().min(10).max(120).default(45),
  speed_ms: z.number().min(1).max(20).default(8),
  /** Punto de despegue; por defecto ~300 m al sur del incidente (simulado). */
  home_lat: z.number().min(-90).max(90).optional(),
  home_lng: z.number().min(-180).max(180).optional(),
});
export type CreateMissionInput = z.infer<typeof CreateMissionInputSchema>;

export const TelemetryInputSchema = z.object({
  points: z
    .array(
      z.object({
        at: z.string().datetime().optional(),
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        alt_m: z.number().min(-100).max(1000),
        heading_deg: z.number().min(0).max(360),
        speed_ms: z.number().min(0).max(100).nullable().optional(),
        battery_pct: z.number().min(0).max(100).nullable().optional(),
      }),
    )
    .min(1)
    .max(60),
  status: z
    .enum(["launching", "en_route", "on_station", "returning", "landed", "aborted"])
    .optional(),
});
export type TelemetryInput = z.infer<typeof TelemetryInputSchema>;

export const StartReconstructionInputSchema = z.object({
  /** Medios a usar; por defecto todos los que tienen video o cuadros reales (no demo). */
  media_ids: z.array(z.string().min(1)).max(50).optional(),
  /** Iteraciones de entrenamiento (más = mejor calidad y más GPU). */
  iterations: z.number().int().min(500).max(30000).optional(),
});
export type StartReconstructionInput = z.infer<typeof StartReconstructionInputSchema>;

/** Lo que el job de GPU reporta al servidor durante y al final del entrenamiento. */
export const ReconstructionUpdateSchema = z.object({
  reconstruction_id: z.string().min(1),
  status: ReconstructionStatusSchema,
  progress: z.number().min(0).max(1),
  message: z.string().max(400).default(""),
  gpu: z.string().max(60).nullable().optional(),
  frame_count: z.number().int().min(0).optional(),
  frames_registered: z.number().int().min(0).nullable().optional(),
  splat_path: z.string().max(400).nullable().optional(),
  splat_format: z.enum(["splat", "ply", "spz"]).nullable().optional(),
  transform: z.array(z.number()).length(16).nullable().optional(),
  alignment: z.enum(["gps", "approximate", "none"]).optional(),
  scale_known: z.boolean().optional(),
  gaussians: z.number().int().min(0).nullable().optional(),
  iterations: z.number().int().min(0).nullable().optional(),
  gpu_seconds: z.number().min(0).nullable().optional(),
  error: z.string().max(1000).nullable().optional(),
});
export type ReconstructionUpdate = z.infer<typeof ReconstructionUpdateSchema>;
