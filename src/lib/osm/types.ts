/**
 * Entorno real de OpenStreetMap alrededor de un incidente, en el sistema local ENU de
 * la escena (metros; x Este, y Norte; origen en incident.lat/lng). Solo tipos.
 */
export interface OsmXY {
  x: number;
  y: number;
}

/** Huella de edificio: `rings[0]` es el exterior; el resto, agujeros (patios). */
export interface OsmBuilding {
  id: string;
  rings: OsmXY[][];
  height: number;
  minHeight: number;
}

/** Eje de una vía (polilínea). `cls` = clase de OpenMapTiles ("primary", "minor", "service"…). */
export interface OsmRoad {
  id: string;
  cls: string;
  name: string | null;
  points: OsmXY[];
}

export interface OsmContext {
  buildings: OsmBuilding[];
  roads: OsmRoad[];
}
