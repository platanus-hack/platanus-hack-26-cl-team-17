/**
 * Configuración visible en el navegador (solo variables NEXT_PUBLIC_*).
 * Next.js reemplaza estas referencias en tiempo de build, por eso se leen
 * de forma literal y no mediante process.env[nombre].
 */
export const publicConfig = {
  /** Estilo de mapa MapLibre (sin API key por defecto). */
  mapStyleDark:
    (process.env.NEXT_PUBLIC_MAP_STYLE_DARK ?? "").trim() ||
    "https://tiles.openfreemap.org/styles/dark",
  mapStyleLight:
    (process.env.NEXT_PUBLIC_MAP_STYLE_LIGHT ?? "").trim() ||
    "https://tiles.openfreemap.org/styles/positron",
  /**
   * Token público de Mapbox (pk.…) para la ficha del incidente: con él se usa el estilo
   * Standard 3D de Mapbox; sin él, MapLibre con un estilo claro equivalente.
   */
  mapboxToken: (process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "").trim(),
  /** Centro inicial del mapa cuando no hay incidentes ni geolocalización (Santiago de Chile). */
  defaultCenter: { lat: -33.4489, lng: -70.6693 },
};
