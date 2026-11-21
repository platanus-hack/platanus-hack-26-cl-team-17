/**
 * Planificación de misiones de dron. Funciones puras (servidor y cliente).
 */
import type { CreateMissionInput, DroneMission, MissionPattern } from "@/lib/domain";
import { destination, gridWaypoints, orbitWaypoints, type LatLng } from "@/lib/geo";

/** Despegue por defecto: a esta distancia al sur del incidente. */
export const DEFAULT_HOME_DISTANCE_M = 300;
/** Máximo de misiones activas (no terminadas) por incidente. */
export const MAX_ACTIVE_MISSIONS = 2;

export type Waypoint = DroneMission["waypoints"][number];

export function planWaypoints(
  center: LatLng,
  pattern: MissionPattern,
  radiusM: number,
  altitudeM: number,
): Waypoint[] {
  if (pattern === "hover") return [{ lat: center.lat, lng: center.lng, alt_m: altitudeM }];
  if (pattern === "grid") return gridWaypoints(center, radiusM, altitudeM);
  return orbitWaypoints(center, radiusM, altitudeM);
}

export function defaultHome(center: LatLng): LatLng {
  return destination(center, 180, DEFAULT_HOME_DISTANCE_M);
}

export interface MissionPlan {
  pattern: MissionPattern;
  radius_m: number;
  altitude_m: number;
  speed_ms: number;
  home_lat: number;
  home_lng: number;
  waypoints: Waypoint[];
}

/** Convierte la entrada validada en el plan que se persiste (sin token ni ids). */
export function planMission(center: LatLng, input: CreateMissionInput): MissionPlan {
  const home =
    input.home_lat !== undefined && input.home_lng !== undefined
      ? { lat: input.home_lat, lng: input.home_lng }
      : defaultHome(center);
  return {
    pattern: input.pattern,
    radius_m: input.radius_m,
    altitude_m: input.altitude_m,
    speed_ms: input.speed_ms,
    home_lat: home.lat,
    home_lng: home.lng,
    waypoints: planWaypoints(center, input.pattern, input.radius_m, input.altitude_m),
  };
}

export function isMissionActive(m: Pick<DroneMission, "status">): boolean {
  return m.status !== "landed" && m.status !== "aborted";
}

const PATTERN_TEXT: Record<MissionPattern, string> = {
  orbit: "órbita",
  hover: "punto fijo",
  grid: "barrido",
};

/** Texto del evento de despliegue, p. ej. "Dron D1 desplegado — órbita de 60 m a 45 m de altura". */
export function deployedTitle(m: Pick<DroneMission, "label" | "pattern" | "radius_m" | "altitude_m">): string {
  const what =
    m.pattern === "hover"
      ? `punto fijo a ${Math.round(m.altitude_m)} m de altura`
      : `${PATTERN_TEXT[m.pattern]} de ${Math.round(m.radius_m)} m a ${Math.round(m.altitude_m)} m de altura`;
  return `Dron ${m.label} desplegado — ${what}`;
}
