/**
 * Textos en español de Chile del visor de reconstrucción (puros, sin React).
 * Coherentes con la terminología de @/lib/labels; se mantienen aquí para que el
 * visor no dependa de módulos de otras sesiones.
 */
import type {
  AccessPointKind,
  Confidence,
  Construction,
  HazardKind,
  HazardSeverity,
  MediaSource,
  MissionMode,
  MissionStatus,
  PersonStatus,
  SmokeColor,
  SmokeVolume,
  StructureKind,
  StructureSide,
  VehicleKind,
  VehicleState,
} from "@/lib/domain";
import type { FireIntensity, NDrone, NFire, NPerson, NStructure, NVehicle, StructureRole } from "./model";

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  low: "baja",
  medium: "media",
  high: "alta",
};

export const STRUCTURE_KIND_LABEL: Record<StructureKind, string> = {
  house_1_story: "Casa de 1 piso",
  house_2_story: "Casa de 2 pisos",
  apartment_building: "Edificio de departamentos",
  commercial: "Local comercial",
  industrial: "Recinto industrial",
  warehouse: "Bodega",
  informal_settlement: "Vivienda de campamento",
  other: "Otra edificación",
  unknown: "Edificación",
};

export const CONSTRUCTION_LABEL: Record<Construction, string> = {
  wood: "madera",
  masonry: "albañilería",
  concrete: "hormigón",
  metal: "estructura metálica",
  light_materials: "materiales ligeros",
  mixed: "mixta",
  unknown: "material no determinado",
};

export const ROLE_LABEL: Record<StructureRole, string> = {
  involved: "Afectada",
  exposure: "Exposición",
  reference: "Referencia",
};

export const ROOF_LABEL: Record<NStructure["roof"], string> = {
  flat: "Techo plano",
  gable: "Techo a dos aguas",
  unknown: "Techo no determinado",
};

export const SIDE_LABEL: Record<StructureSide, string> = {
  front: "Frente (lado A)",
  rear: "Posterior",
  left: "Costado izquierdo",
  right: "Costado derecho",
  roof: "Techo",
  interior: "Interior",
  whole_floor: "Todo el piso",
  unknown: "No determinado",
};

const SIDE_SHORT: Partial<Record<StructureSide, string>> = {
  front: "frente",
  rear: "posterior",
  left: "costado izq.",
  right: "costado der.",
  roof: "techo",
  interior: "interior",
  whole_floor: "todo el piso",
};

export const INTENSITY_LABEL: Record<FireIntensity, string> = {
  smoke_only: "Solo humo",
  light: "Fuego leve",
  moderate: "Fuego moderado",
  heavy: "Fuego intenso",
};

export const SMOKE_COLOR_LABEL: Record<SmokeColor, string> = {
  none: "sin humo",
  white: "blanco",
  gray: "gris",
  black: "negro",
  brown: "café",
  yellow: "amarillento",
  unknown: "color no determinado",
};

export const SMOKE_VOLUME_LABEL: Record<SmokeVolume, string> = {
  none: "nulo",
  light: "leve",
  moderate: "moderado",
  heavy: "denso",
};

export const PERSON_STATUS_LABEL: Record<PersonStatus, string> = {
  trapped: "Atrapada",
  at_window_or_balcony: "En ventana o balcón",
  on_roof: "En el techo",
  injured: "Lesionada",
  evacuating: "Evacuando",
  bystander: "Transeúnte o testigo",
  responder: "Personal de emergencia",
  unknown: "Estado no determinado",
};

export const VEHICLE_KIND_LABEL: Record<VehicleKind, string> = {
  car: "Automóvil",
  suv_pickup: "SUV o camioneta",
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
  on_side: "de costado",
  overturned: "volcado",
  crushed: "aplastado",
  burning: "en llamas",
  unknown: "posición no determinada",
};

export const HAZARD_KIND_LABEL: Record<HazardKind, string> = {
  gas_cylinder: "Cilindros de gas",
  gas_line: "Red de gas",
  power_lines: "Tendido eléctrico",
  electrical: "Riesgo eléctrico",
  fuel_spill: "Derrame de combustible",
  hazmat_placard: "Materiales peligrosos",
  collapse_risk: "Riesgo de colapso",
  explosion_risk: "Riesgo de explosión",
  ev_battery: "Batería de vehículo eléctrico",
  solar_panels: "Paneles solares",
  traffic: "Tránsito",
  crowd: "Aglomeración",
  water_hazard: "Riesgo en agua",
  other: "Peligro",
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
  street_entry: "Ingreso",
  hydrant: "Grifo",
  staging: "Zona de espera",
  command_post: "Puesto de mando",
  other: "Acceso",
};

export const MEDIA_SOURCE_LABEL: Record<MediaSource, string> = {
  citizen: "Vecino",
  drone: "Dron",
  responder: "Personal",
  demo: "Demostración",
};

export const MISSION_STATUS_LABEL: Record<MissionStatus, string> = {
  planned: "Planificada",
  launching: "Despegando",
  en_route: "En camino",
  on_station: "En posición",
  returning: "Regresando",
  landed: "Aterrizado",
  aborted: "Abortada",
};

export const MISSION_MODE_LABEL: Record<MissionMode, string> = {
  simulated: "Simulado",
  device: "Teléfono como sensor",
  api: "Dron real",
};

/** "2º piso". */
export function floorOrdinal(floor: number): string {
  return `${Math.round(floor)}º piso`;
}

export function pluralFloors(n: number): string {
  return n === 1 ? "1 piso" : `${n} pisos`;
}

/** "2 pisos · albañilería" (omite el material si no se sabe). */
export function structureCaption(s: Pick<NStructure, "floors" | "construction">): string {
  const parts = [pluralFloors(s.floors)];
  if (s.construction !== "unknown") parts.push(CONSTRUCTION_LABEL[s.construction]);
  return parts.join(" · ");
}

/** Título de la estructura: su rótulo o el tipo. */
export function structureTitle(s: Pick<NStructure, "label" | "kind">): string {
  return s.label || STRUCTURE_KIND_LABEL[s.kind];
}

function countWord(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

/** "1 persona · ventana 2º piso", "2 personas atrapadas · 1º piso". */
export function personCaption(p: Pick<NPerson, "status" | "count" | "floor">): string {
  const n = p.count;
  const known = n >= 1;
  let who: string;
  switch (p.status) {
    case "bystander":
      who = known ? countWord(n, "transeúnte", "transeúntes") : "Transeúntes";
      break;
    case "responder":
      who = known ? `Personal de emergencia (${n})` : "Personal de emergencia";
      break;
    case "trapped":
      who = known ? countWord(n, "persona atrapada", "personas atrapadas") : "Personas atrapadas (cantidad no determinada)";
      break;
    case "injured":
      who = known ? countWord(n, "persona lesionada", "personas lesionadas") : "Personas lesionadas (cantidad no determinada)";
      break;
    case "evacuating":
      who = known ? `${countWord(n, "persona", "personas")} evacuando` : "Personas evacuando";
      break;
    default:
      who = known ? countWord(n, "persona", "personas") : "Personas (cantidad no determinada)";
  }
  let place = "";
  if (p.status === "at_window_or_balcony") {
    place = p.floor >= 1 ? `ventana ${floorOrdinal(p.floor)}` : "ventana o balcón";
  } else if (p.status === "on_roof") {
    place = "en el techo";
  } else if (p.floor >= 1) {
    place = floorOrdinal(p.floor);
  }
  return place ? `${who} · ${place}` : who;
}

/** "Fuego intenso · 2º piso · posterior". */
export function fireCaption(f: Pick<NFire, "intensity" | "floor" | "side">): string {
  const parts = [f.intensity === "smoke_only" ? "Humo" : INTENSITY_LABEL[f.intensity]];
  if (f.floor >= 1 && f.side !== "roof") parts.push(floorOrdinal(f.floor));
  const side = SIDE_SHORT[f.side];
  if (side) parts.push(side);
  return parts.join(" · ");
}

/** "Automóvil · volcado". */
export function vehicleCaption(v: Pick<NVehicle, "kind" | "state" | "burning">): string {
  const parts = [VEHICLE_KIND_LABEL[v.kind]];
  if (v.state !== "unknown" && v.state !== "upright") parts.push(VEHICLE_STATE_LABEL[v.state]);
  if (v.burning && v.state !== "burning") parts.push("en llamas");
  return parts.join(" · ");
}

/** "D1 · 45 m" (y "simulado" si la misión no es un dron real). */
export function droneCaption(d: Pick<NDrone, "label" | "z" | "mode">): string {
  const parts = [d.label, `${Math.round(d.z)} m`];
  if (d.mode === "simulated") parts.push("simulado");
  return parts.join(" · ");
}

/** "≈ 8 m" con un decimal si es pequeño. */
export function formatMeters(m: number): string {
  const v = Math.abs(m) < 10 ? Math.round(m * 10) / 10 : Math.round(m);
  return `≈ ${String(v).replace(".", ",")} m`;
}

/** "hace 12 s", "hace 3 min", "hace 2 h 5 min", "hace 3 d". null si la fecha no es válida. */
export function formatAgo(iso: string | null, nowMs: number): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  if (s < 60) return `hace ${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `hace ${h} h ${min % 60} min` : `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} d`;
}

/** Fotograma para personas (base 1): "fotograma 3". */
export function frameLabel(frame: number): string | null {
  return frame >= 0 ? `fotograma ${frame + 1}` : null;
}

export const LEGEND_TEXT = "Reconstrucción esquemática inferida por IA · dimensiones aproximadas";
export const EMPTY_TEXT = "La reconstrucción aparecerá con el primer video analizado";

/** Supuestos que agregó el propio visor al dibujar (valores que la IA no entregó o eran inválidos). */
export function viewerAssumptions(scene: {
  structures: Pick<NStructure, "label" | "kind" | "floors" | "width" | "depth" | "assumed">[];
  people: Pick<NPerson, "count">[];
}): string[] {
  const out: string[] = [];
  for (const s of scene.structures) {
    const title = structureTitle(s);
    if (s.assumed.floors) out.push(`${title}: pisos no informados; se dibuja ${pluralFloors(s.floors)}.`);
    if (s.assumed.size) {
      out.push(`${title}: dimensiones no informadas; se dibuja de ${Math.round(s.width)} × ${Math.round(s.depth)} m.`);
    }
  }
  if (scene.people.some((p) => p.count < 1)) {
    out.push("Hay grupos de personas sin cantidad determinada: no significa que sean pocas.");
  }
  return out;
}
