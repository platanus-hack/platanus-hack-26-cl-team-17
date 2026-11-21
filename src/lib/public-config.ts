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
  /** Centro inicial del mapa cuando no hay incidentes ni geolocalización (Santiago de Chile). */
  defaultCenter: { lat: -33.4489, lng: -70.6693 },
};
