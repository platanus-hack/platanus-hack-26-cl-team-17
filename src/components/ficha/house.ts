/**
 * Maquetas 3D para el mapa de la ficha, con el lenguaje del esquema técnico: la casa o
 * edificio como volumen translúcido por piso con losas opacas (el piso del foco encendido),
 * contorno en el suelo y fachada principal marcada; vehículos a escala real con carrocería
 * y cabina. Todo con prismas verticales (fill-extrusion), igual en MapLibre y en Mapbox.
 *
 * Coordenadas: escena local (m, x Este, y Norte) → lng/lat con toLatLng. Ejes de la planta
 * como en el esquema: u hacia la derecha mirando la fachada, v hacia el frente.
 */
import type { SceneModel } from "@/lib/domain";
import { toLatLng, type LatLng } from "@/lib/geo";
import { localToWorld, type Footprint } from "@/components/scene3d/geometry";
import type { LngLat } from "./model";

export interface Part {
  ring: LngLat[];
  /** Agujero opcional (losas en anillo). */
  hole?: LngLat[];
  base: number;
  top: number;
  color: string;
  /** Volumen translúcido (muros del esquema); si no, opaco. */
  glass?: boolean;
}

type Structure = SceneModel["structures"][number];
type Vehicle = SceneModel["vehicles"][number];
type FireZone = SceneModel["fire_zones"][number];

export const HOUSE_COLORS = {
  glassAffected: "#F7A26A",
  glassFire: "#FF5A1F",
  glassExposure: "#A9A296",
  slabAffected: "#FBE8D8",
  slabExposure: "#C7BFB2",
  vehicleAffected: "#F76B15",
  vehicleAffectedCabin: "#FDBE94",
  vehicle: "#C9CDD2",
  vehicleCabin: "#E3E6E9",
} as const;

const finite = (n: unknown, d: number) => (typeof n === "number" && Number.isFinite(n) ? n : d);

/** Rectángulo en ejes de la planta: centro (cu, cv), medio ancho hu (a lo largo de u) y medio largo hv. */
function rect(origin: LatLng, fp: Footprint, cu: number, cv: number, hu: number, hv: number): LngLat[] {
  const pts = [
    [cu - hu, cv + hv],
    [cu + hu, cv + hv],
    [cu + hu, cv - hv],
    [cu - hu, cv - hv],
    [cu - hu, cv + hv],
  ];
  return pts.map(([u, v]) => {
    const w = localToWorld(fp, u, v);
    const ll = toLatLng(origin, w);
    return [ll.lng, ll.lat] as LngLat;
  });
}

type Side = "front" | "rear" | "left" | "right";

/** Pisos y lados con fuego en esta estructura (por id o porque el foco cae dentro de la planta). */
function fireMap(st: Structure, fp: Footprint, fires: readonly FireZone[]): { floor: number; side: Side | "all" }[] {
  const out: { floor: number; side: Side | "all" }[] = [];
  for (const f of fires) {
    const inside = Math.abs(f.x - fp.x) <= fp.width / 2 + 1 && Math.abs(f.y - fp.y) <= fp.depth / 2 + 1;
    if (f.structure_id !== st.id && !inside) continue;
    const side = f.side === "front" || f.side === "rear" || f.side === "left" || f.side === "right" ? f.side : "all";
    out.push({ floor: Math.max(1, Math.round(finite(f.floor, 1))), side });
  }
  return out;
}

export function houseParts(origin: LatLng, st: Structure, fires: readonly FireZone[]): Part[] {
  const affected = st.role === "involved";
  const floors = Math.min(30, Math.max(1, Math.round(finite(st.floors, 1))));
  const fh = Math.min(4.5, Math.max(2.4, finite(st.floor_height_m, 2.7)));
  const width = Math.max(3, finite(st.width_m, 8));
  const depth = Math.max(3, finite(st.depth_m, 10));
  const fp: Footprint = { x: finite(st.x, 0), y: finite(st.y, 0), width, depth, rotationDeg: finite(st.rotation_deg, 0) };
  const hw = width / 2;
  const hd = depth / 2;
  const parts: Part[] = [];
  const burning = fireMap(st, fp, fires);
  const slab = affected ? HOUSE_COLORS.slabAffected : HOUSE_COLORS.slabExposure;

  // Como en el esquema: un volumen translúcido por piso (el del foco, encendido) y losas opacas.
  for (let f = 0; f < floors; f++) {
    const onFire = burning.some((b) => b.floor === f + 1);
    parts.push({
      ring: rect(origin, fp, 0, 0, hw, hd),
      base: f * fh + 0.12,
      top: (f + 1) * fh - 0.08,
      color: onFire ? HOUSE_COLORS.glassFire : affected ? HOUSE_COLORS.glassAffected : HOUSE_COLORS.glassExposure,
      glass: true,
    });
  }
  for (let f = 0; f <= floors; f++) {
    const z = f * fh;
    parts.push({ ring: rect(origin, fp, 0, 0, hw + 0.08, hd + 0.08), base: Math.max(0, z - 0.1), top: z + 0.12, color: slab });
  }
  return parts;
}

/** Contorno de la planta en el suelo y el borde de la fachada principal (lado A). */
export function houseOutline(origin: LatLng, st: Structure): { ring: LngLat[]; front: LngLat[]; affected: boolean } {
  const width = Math.max(3, finite(st.width_m, 8));
  const depth = Math.max(3, finite(st.depth_m, 10));
  const fp: Footprint = { x: finite(st.x, 0), y: finite(st.y, 0), width, depth, rotationDeg: finite(st.rotation_deg, 0) };
  const ring = rect(origin, fp, 0, 0, width / 2, depth / 2);
  return { ring, front: [ring[0], ring[1]], affected: st.role === "involved" };
}

/**
 * Zona donde se oculta el edificio del mapa base: centro de la planta y radio (media diagonal).
 * Cualquier edificio base que toque ese círculo se oculta, aunque sea una manzana entera.
 */
export function houseClearance(origin: LatLng, st: Structure): { at: LngLat; r: number } {
  const w = Math.max(3, finite(st.width_m, 8));
  const d = Math.max(3, finite(st.depth_m, 10));
  const ll = toLatLng(origin, { x: finite(st.x, 0), y: finite(st.y, 0) });
  return { at: [ll.lng, ll.lat], r: Math.hypot(w, d) / 2 };
}

/** Medidas reales por tipo (m): largo, ancho, alto total. */
export const VEHICLE_SIZE: Record<Vehicle["kind"], { l: number; w: number; h: number }> = {
  car: { l: 4.5, w: 1.8, h: 1.45 },
  suv_pickup: { l: 5.2, w: 1.9, h: 1.85 },
  van: { l: 5.0, w: 2.0, h: 2.1 },
  truck: { l: 8.0, w: 2.5, h: 3.3 },
  bus: { l: 12.0, w: 2.55, h: 3.2 },
  motorcycle: { l: 2.1, w: 0.8, h: 1.2 },
  bicycle: { l: 1.8, w: 0.6, h: 1.1 },
  trailer: { l: 7.0, w: 2.5, h: 3.0 },
  other: { l: 4.5, w: 1.8, h: 1.6 },
};

/** Lo que estima la IA, acotado a ±30 % de la medida real del tipo (nunca un auto de 10 m). */
function realistic(value: unknown, real: number): number {
  return Math.min(real * 1.3, Math.max(real * 0.7, finite(value, real)));
}

export function vehicleParts(origin: LatLng, v: Vehicle): Part[] {
  const affected = Boolean(v.entrapment_suspected || v.burning);
  const size = VEHICLE_SIZE[v.kind] ?? VEHICLE_SIZE.other;
  const length = realistic(v.length_m, size.l);
  const width = realistic(v.width_m, size.w);
  const height = size.h;
  // El frente del vehículo mira hacia rotation_deg: a lo largo de v.
  const fp: Footprint = { x: finite(v.x, 0), y: finite(v.y, 0), width, depth: length, rotationDeg: finite(v.rotation_deg, 0) };
  const body = affected ? HOUSE_COLORS.vehicleAffected : HOUSE_COLORS.vehicle;
  const cabin = affected ? HOUSE_COLORS.vehicleAffectedCabin : HOUSE_COLORS.vehicleCabin;
  const hw = width / 2;
  const hl = length / 2;
  const R = (cu: number, cv: number, hu: number, hv: number) => rect(origin, fp, cu, cv, hu, hv);

  if (v.state === "overturned") {
    // Sobre el techo: cabina aplastada abajo, carrocería y ruedas arriba.
    const crushed = height * 0.28;
    return [
      { ring: R(0, -hl * 0.08, hw - 0.12, hl * 0.48), base: 0, top: crushed, color: cabin },
      { ring: R(0, 0, hw, hl), base: crushed, top: crushed + height * 0.55, color: body },
    ];
  }
  if (v.state === "on_side") {
    // De costado: el ancho pasa a ser el alto.
    return [{ ring: R(0, 0, Math.min(hw, height / 2), hl), base: 0, top: width, color: body }];
  }

  switch (v.kind) {
    case "truck":
    case "trailer": {
      // Cabina adelante (20 %) y carga atrás.
      const cabL = Math.min(2.2, length * 0.25);
      return [
        { ring: R(0, hl - cabL / 2, hw, cabL / 2), base: 0.4, top: height * 0.9, color: cabin },
        { ring: R(0, -cabL / 2 - 0.15, hw, hl - cabL / 2 - 0.15), base: 0.6, top: height, color: body },
      ];
    }
    case "bus":
    case "van":
      // Una sola caja alta con el frente un poco más bajo.
      return [
        { ring: R(0, -0.3, hw, hl - 0.3), base: 0.3, top: height, color: body },
        { ring: R(0, hl - 0.3, hw - 0.05, 0.3), base: 0.3, top: height * 0.7, color: cabin },
      ];
    case "motorcycle":
    case "bicycle":
      return [{ ring: R(0, 0, hw, hl), base: 0.25, top: height, color: body }];
    default: {
      // Auto o camioneta: carrocería y cabina (en la camioneta, cabina adelante y pick-up atrás).
      const bodyTop = height * (v.kind === "suv_pickup" ? 0.55 : 0.52);
      const cabin1 =
        v.kind === "suv_pickup"
          ? { ring: R(0, hl * 0.18, hw - 0.1, hl * 0.4), base: bodyTop, top: height, color: cabin }
          : { ring: R(0, -hl * 0.08, hw - 0.12, hl * 0.46), base: bodyTop, top: height, color: cabin };
      return [{ ring: R(0, 0, hw, hl), base: 0.18, top: bodyTop, color: body }, cabin1];
    }
  }
}
