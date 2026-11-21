/**
 * Contrato de los mapas (MapLibre GL). Todos los componentes se exportan desde
 * "@/components/map" ya envueltos para cargarse solo en el navegador.
 */
import type { DroneMission, Incident, SceneModel } from "@/lib/domain";
import type { IncidentSummary, MediaView } from "@/lib/contract";
import type { LatLng } from "@/lib/geo";

export type MapTheme = "dark" | "light";

/** Mapa táctico de UN incidente: posición, cámaras de los medios con rumbo, drones, elementos de la escena con posición. */
export interface TacticalMapProps {
  incident: Pick<Incident, "id" | "lat" | "lng" | "type" | "title" | "address">;
  scene: SceneModel | null;
  media: MediaView[];
  missions: DroneMission[];
  theme?: MapTheme;
  onOpenMedia?: (mediaLabel: string) => void;
  className?: string;
}

/** Mapa general del puesto de mando con todos los incidentes. */
export interface OverviewMapProps {
  incidents: IncidentSummary[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  theme?: MapTheme;
  className?: string;
}

/** Selector de ubicación con un pin arrastrable (crear incidente / corregir ubicación del vecino). */
export interface LocationPickerProps {
  value: LatLng | null;
  onChange: (value: LatLng) => void;
  /** Centro inicial si value es null. */
  initialCenter?: LatLng;
  theme?: MapTheme;
  className?: string;
}

/** Mapa pequeño de solo lectura con marcadores simples. */
export interface MiniMapProps {
  center: LatLng;
  zoom?: number;
  markers?: { lat: number; lng: number; label?: string; tone?: "accent" | "critical" | "info" | "drone" | "neutral" }[];
  theme?: MapTheme;
  interactive?: boolean;
  className?: string;
}
