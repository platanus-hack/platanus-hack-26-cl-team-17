/** Capas del visor (compartidas por 3D y planta 2D). */
import type { SceneEntityKind } from "./types";

export type LayerKey =
  | "structures"
  | "fire"
  | "people"
  | "vehicles"
  | "hazards"
  | "access"
  | "cameras"
  | "drone"
  | "labels";

export type LayerState = Record<LayerKey, boolean>;

export const LAYERS: { key: LayerKey; label: string }[] = [
  { key: "structures", label: "Estructuras" },
  { key: "fire", label: "Fuego y humo" },
  { key: "people", label: "Personas" },
  { key: "vehicles", label: "Vehículos" },
  { key: "hazards", label: "Peligros" },
  { key: "access", label: "Accesos" },
  { key: "cameras", label: "Cámaras" },
  { key: "drone", label: "Dron" },
  { key: "labels", label: "Etiquetas" },
];

export const DEFAULT_LAYERS: LayerState = {
  structures: true,
  fire: true,
  people: true,
  vehicles: true,
  hazards: true,
  access: true,
  cameras: true,
  drone: true,
  labels: true,
};

/** Capa de cada tipo de entidad (las calles son parte del plano base y siempre se ven). */
export const KIND_LAYER: Record<SceneEntityKind, LayerKey | null> = {
  structure: "structures",
  fire: "fire",
  smoke: "fire",
  person: "people",
  vehicle: "vehicles",
  hazard: "hazards",
  access: "access",
  road: null,
  camera: "cameras",
  drone: "drone",
};
