/**
 * Etiquetas en español de Chile, tonos e íconos para cada enumeración del dominio.
 *
 * Datos puros: sin renderizado. Cada mapa es un `Record` exhaustivo, así que
 * agregar un valor a un enum en domain.ts o contract.ts obliga a etiquetarlo aquí.
 *
 * Regla de oro (doctrina): la ausencia de evidencia nunca se presenta como
 * "seguro". Nada que dependa de video se etiqueta "sin víctimas" ni se pinta verde;
 * solo `cleared_by_unit` (informado por radio desde el lugar) usa tono `ok`.
 */
import {
  Activity,
  AppWindow,
  Ban,
  BatteryWarning,
  BellRing,
  Biohazard,
  Bomb,
  Box,
  Building2,
  Car,
  CarFront,
  CircleAlert,
  CircleDot,
  CircleHelp,
  CircleX,
  ClipboardCheck,
  ClipboardList,
  Clock,
  Construction,
  Cylinder,
  DoorOpen,
  Drone,
  Droplet,
  FilePen,
  FilePlus,
  Fence,
  Flag,
  Flame,
  FlaskConical,
  Footprints,
  Fuel,
  Gauge,
  HeartPulse,
  Info,
  LifeBuoy,
  LocateFixed,
  MapPin,
  MapPinned,
  Megaphone,
  MessageSquare,
  Navigation,
  PackagePlus,
  PersonStanding,
  PlaneLanding,
  PlaneTakeoff,
  PlugZap,
  Radio,
  Route,
  ScanEye,
  Send,
  ShieldCheck,
  Signpost,
  Siren,
  Smartphone,
  SolarPanel,
  SquareParking,
  TrafficCone,
  Trees,
  TriangleAlert,
  Truck,
  Undo2,
  Users,
  Waves,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Tone } from "@/components/ui/tone";
import type {
  AccessPointKind,
  AnalysisEngine,
  Cardinal,
  CommEventKind,
  CommSource,
  CommsAnalysis,
  Confidence,
  Construction as ConstructionKind,
  Damage,
  DroneMission,
  FireStage,
  HazardKind,
  HazardSeverity,
  Incident,
  IncidentStatus,
  IncidentType,
  InsightCategory,
  Likelihood,
  Media,
  MediaAnalysis,
  MediaKind,
  MediaSource,
  MediaStatus,
  MissionMode,
  MissionPattern,
  MissionStatus,
  PersonStatus,
  PipelineStatus,
  Priority,
  SceneModel,
  Severity,
  SmokeColor,
  SmokeVolume,
  StructureKind,
  StructureSide,
  TimelineKind,
  TimelineSeverity,
  TrappedStatus,
  UnitStatus,
  VehicleKind,
  VehicleState,
} from "@/lib/domain";
import type { MissionCommandRequest, RuntimeMode, StaffRole } from "@/lib/contract";

/* ═════════════════════ Enumeraciones anidadas (tipos derivados) ═════════════════════ */

/** Altura desde donde se grabó un medio. */
export type Elevation = MediaAnalysis["viewpoint"]["elevation"];
/** Riesgo de propagación estimado en un medio. */
export type SpreadRisk = MediaAnalysis["fire"]["spread_risk"];
/** Si se ven ocupantes en un vehículo. */
export type OccupantsVisible = MediaAnalysis["vehicles"][number]["occupants_visible"];
/** Prioridad de un hecho extraído de comunicaciones. */
export type CommPriority = CommsAnalysis["events"][number]["priority"];
/** Estado de víctimas según el tráfico radial. */
export type CommsVictimsStatus = CommsAnalysis["victims"]["status"];
/** Rol de una edificación en la escena reconstruida. */
export type SceneRole = SceneModel["structures"][number]["role"];
/** Tipo de techumbre en la escena reconstruida. */
export type Roof = SceneModel["structures"][number]["roof"];
/** Intensidad de un foco en la escena reconstruida. */
export type FireIntensity = SceneModel["fire_zones"][number]["intensity"];
/** Estado del video original de un medio. */
export type VideoStatus = Media["video_status"];
/** Origen de un incidente. */
export type IncidentOrigin = Incident["origin"];
/** Orden pendiente para un dron. */
export type MissionCommand = DroneMission["command"];
/** Acción que el mando puede ordenar a una misión. */
export type MissionAction = MissionCommandRequest["action"];
/** Almacenamiento de datos de la instancia. */
export type RuntimeStore = RuntimeMode["store"];
/** Almacenamiento de archivos de la instancia. */
export type RuntimeFiles = RuntimeMode["files"];
/** Modo de autenticación de la instancia. */
export type RuntimeAuth = RuntimeMode["auth"];

/* ═══════════════════════════════ Incidente ═══════════════════════════════ */

/** Tipo de emergencia. */
export const incidentTypeLabel: Record<IncidentType, string> = {
  structure_fire: "Incendio estructural",
  vehicle_fire: "Incendio de vehículo",
  wildland_fire: "Incendio forestal o de pastizal",
  vehicle_collision: "Accidente de tránsito",
  hazmat: "Materiales peligrosos",
  rescue: "Rescate",
  other: "Otra emergencia",
  unknown: "Tipo por determinar",
};

/** Ícono por tipo de emergencia. */
export const incidentTypeIcon: Record<IncidentType, LucideIcon> = {
  structure_fire: Flame,
  vehicle_fire: CarFront,
  wildland_fire: Trees,
  vehicle_collision: Car,
  hazmat: Biohazard,
  rescue: LifeBuoy,
  other: CircleDot,
  unknown: CircleHelp,
};

/** Estado del incidente. */
export const incidentStatusLabel: Record<IncidentStatus, string> = {
  active: "Activo",
  controlled: "Controlado",
  closed: "Cerrado",
};

/** Tono por estado del incidente. */
export const incidentStatusTone: Record<IncidentStatus, Tone> = {
  active: "accent",
  controlled: "warning",
  closed: "neutral",
};

/** Origen del incidente. */
export const incidentOriginLabel: Record<IncidentOrigin, string> = {
  command: "Central",
  citizen: "Reporte de vecino",
  demo: "Simulacro",
};

/* ═══════════════════════════ Personas atrapadas ═══════════════════════════ */

/** Estado de personas atrapadas: texto completo, en mayúsculas, tal como lo exige el mando. */
export const trappedStatusLabel: Record<TrappedStatus, string> = {
  confirmed: "CONFIRMADO",
  probable: "PROBABLE",
  possible: "POSIBLE",
  no_evidence: "SIN EVIDENCIA (no descarta)",
  cleared_by_unit: "DESCARTADO POR UNIDAD EN EL LUGAR",
};

/** Estado de personas atrapadas en forma corta, para chips y listas. */
export const trappedStatusShort: Record<TrappedStatus, string> = {
  confirmed: "CONFIRMADO",
  probable: "PROBABLE",
  possible: "POSIBLE",
  no_evidence: "SIN EVIDENCIA",
  cleared_by_unit: "DESCARTADO POR UNIDAD",
};

/** Titular de personas atrapadas, p. ej. "Personas atrapadas: CONFIRMADO". */
export const trappedStatusHeadline: Record<TrappedStatus, string> = {
  confirmed: `Personas atrapadas: ${trappedStatusLabel.confirmed}`,
  probable: `Personas atrapadas: ${trappedStatusLabel.probable}`,
  possible: `Personas atrapadas: ${trappedStatusLabel.possible}`,
  no_evidence: `Personas atrapadas: ${trappedStatusLabel.no_evidence}`,
  cleared_by_unit: `Personas atrapadas: ${trappedStatusLabel.cleared_by_unit}`,
};

/** Tono por estado de atrapados; `no_evidence` nunca se ve "seguro". */
export const trappedTone: Record<TrappedStatus, Tone> = {
  confirmed: "critical",
  probable: "critical",
  possible: "warning",
  no_evidence: "info",
  cleared_by_unit: "ok",
};

/** Grado de certeza de un hecho (lesionados, atrapamiento vehicular). */
export const likelihoodLabel: Record<Likelihood, string> = {
  confirmed: "Confirmado",
  probable: "Probable",
  possible: "Posible",
  no_evidence: "Sin evidencia (no descarta)",
};

/** Tono por grado de certeza; `no_evidence` nunca se ve "seguro". */
export const likelihoodTone: Record<Likelihood, Tone> = {
  confirmed: "critical",
  probable: "critical",
  possible: "warning",
  no_evidence: "info",
};

/* ═════════════════════ Gravedad, prioridad y confianza ═════════════════════ */

/** Gravedad global del incidente. */
export const severityLabel: Record<Severity, string> = {
  low: "Baja",
  moderate: "Moderada",
  high: "Alta",
  critical: "Crítica",
};

/** Tono por gravedad; la gravedad baja no se pinta verde. */
export const severityTone: Record<Severity, Tone> = {
  low: "info",
  moderate: "warning",
  high: "critical",
  critical: "critical",
};

/** Prioridad de un hallazgo o acción sugerida. */
export const priorityLabel: Record<Priority, string> = {
  critical: "Crítica",
  high: "Alta",
  medium: "Media",
  low: "Baja",
};

/** Tono por prioridad. */
export const priorityTone: Record<Priority, Tone> = {
  critical: "critical",
  high: "warning",
  medium: "info",
  low: "neutral",
};

/** Nivel de confianza (forma breve: "Baja", "Media", "Alta"). */
export const confidenceLabel: Record<Confidence, string> = {
  low: "Baja",
  medium: "Media",
  high: "Alta",
};

/** Nivel de confianza con sustantivo: "Confianza baja". */
export const confidenceLongLabel: Record<Confidence, string> = {
  low: "Confianza baja",
  medium: "Confianza media",
  high: "Confianza alta",
};

/** Tono por nivel de confianza. */
export const confidenceTone: Record<Confidence, Tone> = {
  low: "warning",
  medium: "info",
  high: "ok",
};

/* ═══════════════════════════ Edificación y fuego ═══════════════════════════ */

/** Tipo de edificación. */
export const structureKindLabel: Record<StructureKind, string> = {
  house_1_story: "Casa de 1 piso",
  house_2_story: "Casa de 2 pisos",
  apartment_building: "Edificio de departamentos",
  commercial: "Local comercial",
  industrial: "Industria",
  warehouse: "Bodega",
  informal_settlement: "Campamento (viviendas precarias)",
  other: "Otra edificación",
  unknown: "Edificación no determinada",
};

/** Material predominante de construcción. */
export const constructionLabel: Record<ConstructionKind, string> = {
  wood: "Madera",
  masonry: "Albañilería",
  concrete: "Hormigón",
  metal: "Estructura metálica",
  light_materials: "Material ligero",
  mixed: "Mixta",
  unknown: "Construcción no determinada",
};

/** Etapa del fuego (la IA solo informa "compatible con"). */
export const fireStageLabel: Record<FireStage, string> = {
  none: "Sin fuego visible",
  incipient: "Incipiente",
  growth: "Crecimiento",
  fully_developed: "Pleno desarrollo",
  decay: "Decaimiento",
  unknown: "Etapa no determinada",
};

/** Lado de la estructura (convención A/B/C/D en sentido horario desde el frente). */
export const structureSideLabel: Record<StructureSide, string> = {
  front: "Lado A (frente)",
  left: "Lado B (izquierdo)",
  rear: "Lado C (posterior)",
  right: "Lado D (derecho)",
  roof: "Techumbre",
  interior: "Interior",
  whole_floor: "Piso completo",
  unknown: "Lado no determinado",
};

/** Lado de la estructura en forma corta, para planos y chips ("A", "B", "Techo"…). */
export const structureSideShort: Record<StructureSide, string> = {
  front: "A",
  left: "B",
  rear: "C",
  right: "D",
  roof: "Techo",
  interior: "Int.",
  whole_floor: "Piso",
  unknown: "?",
};

/** Color del humo (dato poco confiable en video: cámara, noche y balizas lo alteran). */
export const smokeColorLabel: Record<SmokeColor, string> = {
  none: "Sin humo visible",
  white: "Blanco",
  gray: "Gris",
  black: "Negro",
  brown: "Café",
  yellow: "Amarillento",
  unknown: "Color no determinado",
};

/** Volumen de humo. */
export const smokeVolumeLabel: Record<SmokeVolume, string> = {
  none: "Sin humo visible",
  light: "Escaso",
  moderate: "Moderado",
  heavy: "Abundante",
};

/** Riesgo de propagación. */
export const spreadRiskLabel: Record<SpreadRisk, string> = {
  low: "Bajo",
  moderate: "Moderado",
  high: "Alto",
  unknown: "No determinado",
};

/** Tono por riesgo de propagación; riesgo bajo no se pinta verde. */
export const spreadRiskTone: Record<SpreadRisk, Tone> = {
  low: "info",
  moderate: "warning",
  high: "critical",
  unknown: "neutral",
};

/** Desde dónde se grabó un medio. */
export const elevationLabel: Record<Elevation, string> = {
  ground: "A nivel de calle",
  elevated: "Elevada",
  aerial: "Aérea",
  interior: "Desde el interior",
  unknown: "No determinada",
};

/** Rol de una edificación en la escena. */
export const sceneRoleLabel: Record<SceneRole, string> = {
  involved: "Afectada",
  exposure: "Exposición",
  reference: "Referencia",
};

/** Tipo de techumbre. */
export const roofLabel: Record<Roof, string> = {
  flat: "Techumbre plana",
  gable: "Techumbre a dos aguas",
  unknown: "Techumbre no determinada",
};

/** Intensidad de un foco en la escena. */
export const fireIntensityLabel: Record<FireIntensity, string> = {
  smoke_only: "Solo humo",
  light: "Fuego leve",
  moderate: "Fuego moderado",
  heavy: "Fuego intenso",
};

/** Tono por intensidad de foco. */
export const fireIntensityTone: Record<FireIntensity, Tone> = {
  smoke_only: "warning",
  light: "warning",
  moderate: "critical",
  heavy: "critical",
};

/* ═══════════════════════════════ Personas ═══════════════════════════════ */

/** Situación de una persona o grupo observado. */
export const personStatusLabel: Record<PersonStatus, string> = {
  trapped: "Persona atrapada",
  at_window_or_balcony: "En ventana o balcón",
  on_roof: "En el techo",
  injured: "Persona lesionada",
  evacuating: "Evacuando",
  bystander: "Testigos o curiosos",
  responder: "Personal de emergencia",
  unknown: "Situación no determinada",
};

/** Tono por situación de persona; una situación desconocida no se ve "segura". */
export const personStatusTone: Record<PersonStatus, Tone> = {
  trapped: "critical",
  at_window_or_balcony: "critical",
  on_roof: "critical",
  injured: "warning",
  evacuating: "warning",
  bystander: "neutral",
  responder: "info",
  unknown: "warning",
};

/* ═══════════════════════════════ Vehículos ═══════════════════════════════ */

/** Tipo de vehículo. */
export const vehicleKindLabel: Record<VehicleKind, string> = {
  car: "Automóvil",
  suv_pickup: "SUV o camioneta",
  van: "Furgón",
  truck: "Camión",
  bus: "Bus",
  motorcycle: "Motocicleta",
  bicycle: "Bicicleta",
  trailer: "Remolque o acoplado",
  other: "Otro vehículo",
};

/** Posición o estado del vehículo. */
export const vehicleStateLabel: Record<VehicleState, string> = {
  upright: "Sobre sus ruedas",
  on_side: "Sobre un costado",
  overturned: "Volcado sobre el techo",
  crushed: "Aplastado o muy deformado",
  burning: "En llamas",
  unknown: "Posición no determinada",
};

/** Daño del vehículo. */
export const damageLabel: Record<Damage, string> = {
  minor: "Daño leve",
  moderate: "Daño moderado",
  severe: "Daño severo",
  unknown: "Daño no determinado",
};

/** Ocupantes visibles en un vehículo ("no se ven" no significa que no haya). */
export const occupantsVisibleLabel: Record<OccupantsVisible, string> = {
  yes: "Se ven ocupantes",
  no: "No se ven ocupantes",
  unknown: "No se puede determinar",
};

/* ═══════════════════════════════ Peligros ═══════════════════════════════ */

/** Tipo de peligro. */
export const hazardKindLabel: Record<HazardKind, string> = {
  gas_cylinder: "Cilindro de gas",
  gas_line: "Red o medidor de gas",
  power_lines: "Tendido eléctrico",
  electrical: "Riesgo eléctrico",
  fuel_spill: "Derrame de fluidos",
  hazmat_placard: "Rotulación de materiales peligrosos",
  collapse_risk: "Riesgo de colapso",
  explosion_risk: "Riesgo de explosión",
  ev_battery: "Batería de vehículo eléctrico",
  solar_panels: "Paneles solares",
  traffic: "Tránsito vehicular",
  crowd: "Aglomeración de personas",
  water_hazard: "Riesgo acuático",
  other: "Otro peligro",
};

/** Ícono por tipo de peligro. */
export const hazardKindIcon: Record<HazardKind, LucideIcon> = {
  gas_cylinder: Cylinder,
  gas_line: Gauge,
  power_lines: Zap,
  electrical: PlugZap,
  fuel_spill: Fuel,
  hazmat_placard: Biohazard,
  collapse_risk: Construction,
  explosion_risk: Bomb,
  ev_battery: BatteryWarning,
  solar_panels: SolarPanel,
  traffic: TrafficCone,
  crowd: Users,
  water_hazard: Waves,
  other: TriangleAlert,
};

/** Gravedad de un peligro. */
export const hazardSeverityLabel: Record<HazardSeverity, string> = {
  low: "Baja",
  medium: "Media",
  high: "Alta",
};

/** Tono por gravedad de peligro. */
export const hazardSeverityTone: Record<HazardSeverity, Tone> = {
  low: "info",
  medium: "warning",
  high: "critical",
};

/* ═══════════════════════════ Comunicaciones ═══════════════════════════ */

/** Estado de una unidad según radio. */
export const unitStatusLabel: Record<UnitStatus, string> = {
  dispatched: "Despachada",
  en_route: "En ruta",
  on_scene: "En el lugar",
  operating: "Trabajando",
  available: "Disponible",
  unknown: "Sin información",
};

/** Tono por estado de unidad. */
export const unitStatusTone: Record<UnitStatus, Tone> = {
  dispatched: "info",
  en_route: "info",
  on_scene: "accent",
  operating: "accent",
  available: "ok",
  unknown: "neutral",
};

/** Tipo de hecho extraído del tráfico radial. */
export const commEventKindLabel: Record<CommEventKind, string> = {
  dispatch: "Despacho",
  arrival: "Llegada al lugar",
  size_up: "Pre-informe",
  victim_report: "Reporte de víctimas",
  mayday: "Emergencia de bombero (MAYDAY)",
  resource_request: "Solicitud de recursos",
  hazard: "Peligro informado",
  order: "Orden",
  status_update: "Actualización de estado",
  all_clear: "Despeje informado por unidad",
  other: "Otro",
};

/** Ícono por tipo de hecho radial. */
export const commEventKindIcon: Record<CommEventKind, LucideIcon> = {
  dispatch: Send,
  arrival: MapPinned,
  size_up: ClipboardList,
  victim_report: PersonStanding,
  mayday: Siren,
  resource_request: PackagePlus,
  hazard: TriangleAlert,
  order: Megaphone,
  status_update: Activity,
  all_clear: ClipboardCheck,
  other: MessageSquare,
};

/** Prioridad de un hecho radial. */
export const commPriorityLabel: Record<CommPriority, string> = {
  routine: "Rutina",
  important: "Importante",
  critical: "Crítica",
};

/** Tono por prioridad de hecho radial. */
export const commPriorityTone: Record<CommPriority, Tone> = {
  routine: "neutral",
  important: "warning",
  critical: "critical",
};

/** Estado de víctimas según radio; solo una unidad en el lugar puede negarlas. */
export const commsVictimsStatusLabel: Record<CommsVictimsStatus, string> = {
  reported: "Se informan víctimas",
  denied_by_unit: "Unidad en el lugar informa que no hay",
  unknown: "Sin información (no descarta)",
};

/** Tono por estado de víctimas según radio. */
export const commsVictimsStatusTone: Record<CommsVictimsStatus, Tone> = {
  reported: "critical",
  denied_by_unit: "ok",
  unknown: "info",
};

/** Cómo ingresó una entrada de comunicaciones. */
export const commSourceLabel: Record<CommSource, string> = {
  manual: "Ingreso manual",
  dictation: "Dictado",
  simulated: "Simulada",
  import: "Importada",
  zello: "Zello",
};

/** Texto de una transmisión hablada que llegó con grabación pero sin transcripción. */
export const UNTRANSCRIBED_COMM_TEXT = "[Transmisión sin transcribir: escuchar la grabación]";

/* ═══════════════════════════ Informe de situación ═══════════════════════════ */

/** Categoría de un hallazgo. */
export const insightCategoryLabel: Record<InsightCategory, string> = {
  life_safety: "Vidas en riesgo",
  fire_behavior: "Comportamiento del fuego",
  structure: "Estructura",
  vehicle: "Vehículos",
  hazard: "Peligros",
  access: "Acceso",
  resources: "Recursos",
  other: "Otros",
};

/** Ícono por categoría de hallazgo. */
export const insightCategoryIcon: Record<InsightCategory, LucideIcon> = {
  life_safety: HeartPulse,
  fire_behavior: Flame,
  structure: Building2,
  vehicle: CarFront,
  hazard: TriangleAlert,
  access: Route,
  resources: Truck,
  other: Info,
};

/* ═══════════════════════════════ Escena ═══════════════════════════════ */

/** Tipo de punto de acceso o referencia táctica. */
export const accessPointKindLabel: Record<AccessPointKind, string> = {
  door: "Puerta",
  gate: "Portón",
  window: "Ventana",
  stairwell: "Caja de escala",
  street_entry: "Acceso desde la calle",
  hydrant: "Grifo",
  staging: "Zona de resguardo de material mayor",
  command_post: "Puesto de mando",
  other: "Otro punto",
};

/** Ícono por tipo de punto de acceso. */
export const accessPointKindIcon: Record<AccessPointKind, LucideIcon> = {
  door: DoorOpen,
  gate: Fence,
  window: AppWindow,
  stairwell: Footprints,
  street_entry: Signpost,
  hydrant: Droplet,
  staging: SquareParking,
  command_post: Flag,
  other: MapPin,
};

/** Punto cardinal (nombre completo). */
export const cardinalLabel: Record<Cardinal, string> = {
  N: "Norte",
  NE: "Noreste",
  E: "Este",
  SE: "Sureste",
  S: "Sur",
  SW: "Suroeste",
  W: "Oeste",
  NW: "Noroeste",
  unknown: "Orientación no determinada",
};

/** Punto cardinal abreviado en español ("SO", "O", "NO"…). */
export const cardinalShort: Record<Cardinal, string> = {
  N: "N",
  NE: "NE",
  E: "E",
  SE: "SE",
  S: "S",
  SW: "SO",
  W: "O",
  NW: "NO",
  unknown: "—",
};

/* ═══════════════════════════════ Medios ═══════════════════════════════ */

/** Quién aportó un medio. */
export const mediaSourceLabel: Record<MediaSource, string> = {
  citizen: "Vecino",
  drone: "Dron",
  responder: "Personal de Bomberos",
  demo: "Demostración",
};

/** Ícono por fuente del medio. */
export const mediaSourceIcon: Record<MediaSource, LucideIcon> = {
  citizen: Smartphone,
  drone: Drone,
  responder: ShieldCheck,
  demo: FlaskConical,
};

/** Tipo de medio. */
export const mediaKindLabel: Record<MediaKind, string> = {
  video: "Video",
  photo: "Foto",
  frames: "Fotogramas",
};

/** Estado de procesamiento de un medio. */
export const mediaStatusLabel: Record<MediaStatus, string> = {
  uploading: "Subiendo",
  uploaded: "Recibido",
  analyzing: "Analizando",
  analyzed: "Analizado",
  failed: "Falló",
};

/** Tono por estado de medio. */
export const mediaStatusTone: Record<MediaStatus, Tone> = {
  uploading: "info",
  uploaded: "neutral",
  analyzing: "info",
  analyzed: "ok",
  failed: "critical",
};

/** Estado del video original de un medio. */
export const videoStatusLabel: Record<VideoStatus, string> = {
  none: "Sin video original",
  uploading: "Subiendo video",
  uploaded: "Video disponible",
  failed: "Falló la subida del video",
};

/* ═══════════════════════════════ Dron ═══════════════════════════════ */

/** Estado de una misión de dron. */
export const missionStatusLabel: Record<MissionStatus, string> = {
  planned: "Planificada",
  launching: "Despegando",
  en_route: "En ruta",
  on_station: "En posición",
  returning: "Regresando",
  landed: "En tierra",
  aborted: "Abortada",
};

/** Tono por estado de misión. */
export const missionStatusTone: Record<MissionStatus, Tone> = {
  planned: "neutral",
  launching: "drone",
  en_route: "drone",
  on_station: "drone",
  returning: "info",
  landed: "neutral",
  aborted: "warning",
};

/** Ícono por estado de misión. */
export const missionStatusIcon: Record<MissionStatus, LucideIcon> = {
  planned: Clock,
  launching: PlaneTakeoff,
  en_route: Navigation,
  on_station: LocateFixed,
  returning: Undo2,
  landed: PlaneLanding,
  aborted: Ban,
};

/** Patrón de vuelo. */
export const missionPatternLabel: Record<MissionPattern, string> = {
  orbit: "Órbita",
  hover: "Vuelo estacionario",
  grid: "Barrido en cuadrícula",
};

/** Origen de la telemetría de la misión. */
export const missionModeLabel: Record<MissionMode, string> = {
  simulated: "Simulada",
  device: "Teléfono como sensor",
  api: "Dron real (API)",
};

/** Orden pendiente que recibe el dron. */
export const missionCommandLabel: Record<MissionCommand, string> = {
  continue: "Continuar",
  recall: "Regreso ordenado",
  abort: "Aborto ordenado",
};

/** Acción que el mando puede ordenar a una misión (texto de botón). */
export const missionActionLabel: Record<MissionAction, string> = {
  recall: "Ordenar regreso",
  abort: "Abortar misión",
  resume: "Reanudar misión",
};

/* ═══════════════════════════════ Bitácora ═══════════════════════════════ */

/** Tipo de evento de la bitácora. */
export const timelineKindLabel: Record<TimelineKind, string> = {
  incident_created: "Incidente creado",
  incident_updated: "Incidente actualizado",
  media_received: "Medio recibido",
  media_analyzed: "Medio analizado",
  media_failed: "Error en un medio",
  alert: "Alerta",
  situation_updated: "Informe de situación actualizado",
  scene_updated: "Escena actualizada",
  comms: "Comunicaciones",
  comms_alert: "Alerta radial",
  drone: "Dron",
  error: "Error",
};

/** Ícono por tipo de evento de la bitácora. */
export const timelineKindIcon: Record<TimelineKind, LucideIcon> = {
  incident_created: FilePlus,
  incident_updated: FilePen,
  media_received: Smartphone,
  media_analyzed: ScanEye,
  media_failed: CircleX,
  alert: BellRing,
  situation_updated: ClipboardList,
  scene_updated: Box,
  comms: Radio,
  comms_alert: Siren,
  drone: Drone,
  error: CircleAlert,
};

/** Severidad de un evento de la bitácora. */
export const timelineSeverityLabel: Record<TimelineSeverity, string> = {
  info: "Información",
  notice: "Aviso",
  warning: "Advertencia",
  critical: "Crítico",
};

/** Tono por severidad de evento. */
export const timelineSeverityTone: Record<TimelineSeverity, Tone> = {
  info: "neutral",
  notice: "info",
  warning: "warning",
  critical: "critical",
};

/* ═══════════════════════════ Sistema y personal ═══════════════════════════ */

/** Rol del personal. */
export const staffRoleLabel: Record<StaffRole, string> = {
  admin: "Administrador",
  officer: "Oficial",
  operator: "Operador",
};

/** Motor que produjo un análisis. */
export const analysisEngineLabel: Record<AnalysisEngine, string> = {
  claude: "IA (Claude)",
  simulated: "Simulado",
};

/** Tono por motor de análisis; lo simulado siempre se marca. */
export const analysisEngineTone: Record<AnalysisEngine, Tone> = {
  claude: "neutral",
  simulated: "warning",
};

/** Estado del pipeline de fusión o comunicaciones. */
export const pipelineStatusLabel: Record<PipelineStatus, string> = {
  idle: "En espera",
  pending: "Pendiente",
  running: "Procesando",
  error: "Error",
};

/** Tono por estado del pipeline. */
export const pipelineStatusTone: Record<PipelineStatus, Tone> = {
  idle: "neutral",
  pending: "info",
  running: "info",
  error: "critical",
};

/** Almacenamiento de datos de la instancia. */
export const runtimeStoreLabel: Record<RuntimeStore, string> = {
  postgres: "Base de datos",
  local: "Local (.data/)",
};

/** Almacenamiento de archivos de la instancia. */
export const runtimeFilesLabel: Record<RuntimeFiles, string> = {
  gcs: "Cloud Storage",
  local: "Local (.data/files)",
};

/** Modo de acceso de la instancia. */
export const runtimeAuthLabel: Record<RuntimeAuth, string> = {
  staff: "Con inicio de sesión",
  open: "Acceso abierto",
};

/* ═══════════════════════════════ Utilidades ═══════════════════════════════ */

/** true si el estado de atrapados exige alarma (confirmado o probable). */
export function isTrappedAlarm(s: TrappedStatus | null | undefined): boolean {
  return s === "confirmed" || s === "probable";
}

const SEVERITY_RANK: Record<Severity, number> = { low: 0, moderate: 1, high: 2, critical: 3 };

/** Orden de gravedad: critical 3 … low 0; null → -1. */
export function severityRank(s: Severity | null | undefined): number {
  return s ? (SEVERITY_RANK[s] ?? -1) : -1;
}

const TRAPPED_RANK: Record<TrappedStatus, number> = {
  confirmed: 4,
  probable: 3,
  possible: 2,
  no_evidence: 1,
  cleared_by_unit: 0,
};

/** Orden de urgencia de atrapados: confirmed 4 … cleared_by_unit 0; sin dato → 1 (nunca "seguro"). */
export function trappedRank(s: TrappedStatus | null | undefined): number {
  return s ? (TRAPPED_RANK[s] ?? 1) : 1;
}

/** Etiqueta de `v` en `map`, o `fallback` si falta o es un valor desconocido (datos externos). */
export function labelOr<T extends string>(
  map: Record<T, string>,
  v: T | null | undefined,
  fallback = "—",
): string {
  if (v == null || !Object.prototype.hasOwnProperty.call(map, v)) return fallback;
  return map[v] || fallback;
}
