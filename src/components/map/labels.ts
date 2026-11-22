/**
 * Textos de los mapas (español de Chile). Locales a esta carpeta para no depender del
 * orden de entrega de `@/lib/labels`; los valores siguen la misma terminología.
 */
import type {
  AccessPointKind,
  MediaKind,
  MediaSource,
  StructureSide,
  Confidence,
  HazardKind,
  HazardSeverity,
  IncidentStatus,
  IncidentType,
  MissionStatus,
  PersonStatus,
  Severity,
  TrappedStatus,
  VehicleKind,
  VehicleState,
} from "@/lib/domain";
import { formatCoord } from "@/lib/format";

export const INCIDENT_TYPE_LABEL: Record<IncidentType, string> = {
  structure_fire: "Incendio estructural",
  vehicle_fire: "Incendio vehicular",
  wildland_fire: "Incendio forestal",
  vehicle_collision: "Accidente vehicular",
  hazmat: "Materiales peligrosos",
  rescue: "Rescate",
  other: "Otra emergencia",
  unknown: "Tipo por confirmar",
};

export const INCIDENT_STATUS_LABEL: Record<IncidentStatus, string> = {
  active: "Activo",
  controlled: "Controlado",
  closed: "Cerrado",
};

export const SEVERITY_LABEL: Record<Severity, string> = {
  low: "Baja",
  moderate: "Moderada",
  high: "Alta",
  critical: "Crítica",
};

export const TRAPPED_LABEL: Record<TrappedStatus, string> = {
  confirmed: "Confirmado",
  probable: "Probable",
  possible: "Posible",
  no_evidence: "Sin evidencia (no descarta)",
  cleared_by_unit: "Descartado por unidad en el lugar",
};

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  low: "baja",
  medium: "media",
  high: "alta",
};

const PERSON_STATUS_PLURAL: Record<PersonStatus, string> = {
  trapped: "atrapadas",
  at_window_or_balcony: "en ventana o balcón",
  on_roof: "en el techo",
  injured: "lesionadas",
  evacuating: "evacuando",
  bystander: "transeúntes",
  responder: "del personal de emergencia",
  unknown: "en estado desconocido",
};

const PERSON_STATUS_SINGULAR: Record<PersonStatus, string> = {
  trapped: "atrapada",
  at_window_or_balcony: "en ventana o balcón",
  on_roof: "en el techo",
  injured: "lesionada",
  evacuating: "evacuando",
  bystander: "transeúnte",
  responder: "del personal de emergencia",
  unknown: "en estado desconocido",
};

/** "2 personas atrapadas", "1 persona en el techo", "Personas atrapadas (cantidad sin confirmar)". */
export function personGroupLabel(status: PersonStatus, count: number): string {
  if (!Number.isFinite(count) || count <= 0) {
    return `Personas ${PERSON_STATUS_PLURAL[status]} (cantidad sin confirmar)`;
  }
  const n = Math.round(count);
  return n === 1 ? `1 persona ${PERSON_STATUS_SINGULAR[status]}` : `${n} personas ${PERSON_STATUS_PLURAL[status]}`;
}

export const STRUCTURE_SIDE_LABEL: Record<StructureSide, string> = {
  front: "fachada",
  rear: "parte trasera",
  left: "costado izquierdo",
  right: "costado derecho",
  roof: "techo",
  interior: "interior",
  whole_floor: "todo el piso",
  unknown: "",
};

export const FIRE_INTENSITY_LABEL: Record<"smoke_only" | "light" | "moderate" | "heavy", string> = {
  smoke_only: "Solo humo",
  light: "Fuego leve",
  moderate: "Fuego moderado",
  heavy: "Fuego intenso",
};

export const STRUCTURE_ROLE_LABEL: Record<"involved" | "exposure" | "reference", string> = {
  involved: "Estructura afectada",
  exposure: "Exposición (riesgo de propagación)",
  reference: "Referencia",
};

export const MEDIA_SOURCE_LABEL: Record<MediaSource, string> = {
  citizen: "de vecino",
  drone: "de dron",
  responder: "de bomberos",
};

export const MEDIA_KIND_LABEL: Record<MediaKind, string> = {
  video: "Video",
  photo: "Foto",
  frames: "Cuadros",
};

export const HAZARD_KIND_LABEL: Record<HazardKind, string> = {
  gas_cylinder: "Cilindro de gas",
  gas_line: "Red de gas",
  power_lines: "Tendido eléctrico",
  electrical: "Riesgo eléctrico",
  fuel_spill: "Derrame de combustible",
  hazmat_placard: "Material peligroso rotulado",
  collapse_risk: "Riesgo de colapso",
  explosion_risk: "Riesgo de explosión",
  ev_battery: "Batería de vehículo eléctrico",
  solar_panels: "Paneles solares",
  traffic: "Tránsito",
  crowd: "Aglomeración de personas",
  water_hazard: "Riesgo por agua",
  other: "Otro peligro",
};

export const HAZARD_SEVERITY_LABEL: Record<HazardSeverity, string> = {
  low: "baja",
  medium: "media",
  high: "alta",
};

export const ACCESS_KIND_LABEL: Record<AccessPointKind, string> = {
  door: "Puerta",
  gate: "Portón",
  window: "Ventana",
  stairwell: "Escalera",
  street_entry: "Entrada desde la calle",
  hydrant: "Grifo",
  staging: "Zona de espera",
  command_post: "Puesto de mando",
  other: "Acceso",
};

export const VEHICLE_KIND_LABEL: Record<VehicleKind, string> = {
  car: "Automóvil",
  suv_pickup: "Camioneta",
  van: "Furgón",
  truck: "Camión",
  bus: "Bus",
  motorcycle: "Motocicleta",
  bicycle: "Bicicleta",
  trailer: "Remolque",
  other: "Vehículo",
};

export const VEHICLE_STATE_LABEL: Record<VehicleState, string> = {
  upright: "sobre sus ruedas",
  on_side: "volcado de costado",
  overturned: "volcado",
  crushed: "aplastado",
  burning: "en llamas",
  unknown: "estado desconocido",
};

export const MISSION_STATUS_LABEL: Record<MissionStatus, string> = {
  planned: "Planificada",
  launching: "Despegando",
  en_route: "En camino",
  on_station: "Sobre el objetivo",
  returning: "Regresando",
  landed: "Aterrizado",
  aborted: "Abortada",
};

/** "-33.44890, -70.66930": mismo formato que el resto de la interfaz (se puede copiar a otra app de mapas). */
export function formatLatLng(p: { lat: number; lng: number }): string {
  return formatCoord(p.lat, p.lng);
}

export function formatMeters(m: number): string {
  if (!Number.isFinite(m)) return "—";
  if (m >= 1000) return `${(m / 1000).toLocaleString("es-CL", { maximumFractionDigits: 1 })} km`;
  return `${Math.round(m)} m`;
}

/** Recorta un texto para etiquetas cortas del mapa. */
export function shortText(text: string, max = 24): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}
