/**
 * Estilos base: satélite (imágenes de Esri con calles y nombres encima) y un respaldo ráster
 * mínimo de OpenStreetMap definido en línea, que carga sin pedir ningún JSON a la red.
 * Si tampoco hay teselas, la capa de fondo deja un color liso y los marcadores siguen visibles.
 */
import type { StyleSpecification } from "maplibre-gl";
import type { MapPalette } from "./palette";
import type { MapTheme } from "./types";

/** Prefijo de las fuentes y capas propias (para distinguir sus errores de los del mapa base). */
export const OVERLAY_PREFIX = "vg-";
export const FALLBACK_SOURCE_ID = "osm-raster";

const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";

/** Estilo principal: vista satelital, igual en ambos temas (los marcadores usan la paleta del tema). */
export function satelliteStyle(): StyleSpecification {
  const raster = (service: string, attribution?: string) => ({
    type: "raster" as const,
    tiles: [`${ESRI}/${service}/MapServer/tile/{z}/{y}/{x}`],
    tileSize: 256,
    maxzoom: 19,
    ...(attribution ? { attribution } : {}),
  });
  return {
    version: 8,
    name: "Vigía · satélite",
    sources: {
      "esri-imagery": raster("World_Imagery", "Imágenes © Esri, Maxar, Earthstar Geographics"),
      "esri-roads": raster("Reference/World_Transportation"),
      "esri-places": raster("Reference/World_Boundaries_and_Places"),
    },
    layers: [
      { id: "sat-background", type: "background", paint: { "background-color": "#0b1016" } },
      { id: "sat-imagery", type: "raster", source: "esri-imagery" },
      { id: "sat-roads", type: "raster", source: "esri-roads", paint: { "raster-opacity": 0.75 } },
      { id: "sat-places", type: "raster", source: "esri-places" },
    ],
  };
}

export function rasterFallbackStyle(theme: MapTheme, palette: MapPalette): StyleSpecification {
  return {
    version: 8,
    name: "Vigía · respaldo OpenStreetMap",
    sources: {
      [FALLBACK_SOURCE_ID]: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        maxzoom: 19,
        attribution:
          '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap</a>',
      },
    },
    layers: [
      { id: "fallback-background", type: "background", paint: { "background-color": palette.bg } },
      {
        id: "fallback-osm",
        type: "raster",
        source: FALLBACK_SOURCE_ID,
        // En oscuro se invierte la luminosidad (min > max) y se rota el tono para conservar los colores.
        paint:
          theme === "dark"
            ? {
                "raster-brightness-min": 0.88,
                "raster-brightness-max": 0.04,
                "raster-hue-rotate": 180,
                "raster-saturation": -0.45,
                "raster-contrast": 0.05,
              }
            : { "raster-saturation": -0.25 },
      },
    ],
  };
}

/** Textos de los controles nativos de MapLibre. */
export const MAP_LOCALE_ES: Record<string, string> = {
  "AttributionControl.ToggleAttribution": "Mostrar u ocultar la atribución",
  "AttributionControl.MapFeedback": "Comentarios sobre el mapa",
  "Map.Title": "Mapa",
  "Marker.Title": "Marcador",
  "NavigationControl.ResetBearing": "Orientar al norte",
  "NavigationControl.ZoomIn": "Acercar",
  "NavigationControl.ZoomOut": "Alejar",
  "Popup.Close": "Cerrar",
  "ScaleControl.Meters": "m",
  "ScaleControl.Kilometers": "km",
  "CooperativeGesturesHandler.WindowsHelpText": "Usa Ctrl + rueda para hacer zoom en el mapa",
  "CooperativeGesturesHandler.MacHelpText": "Usa ⌘ + rueda para hacer zoom en el mapa",
  "CooperativeGesturesHandler.MobileHelpText": "Usa dos dedos para mover el mapa",
};
