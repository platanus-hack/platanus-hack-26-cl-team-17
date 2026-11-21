/**
 * Estilos base: el vectorial configurado (OpenFreeMap por defecto) y un respaldo ráster
 * mínimo de OpenStreetMap definido en línea, que carga sin pedir ningún JSON a la red.
 * Si tampoco hay teselas, la capa de fondo deja un color liso y los marcadores siguen visibles.
 */
import type { StyleSpecification } from "maplibre-gl";
import { publicConfig } from "@/lib/public-config";
import type { MapPalette } from "./palette";
import type { MapTheme } from "./types";

/** Prefijo de las fuentes y capas propias (para distinguir sus errores de los del mapa base). */
export const OVERLAY_PREFIX = "vg-";
export const FALLBACK_SOURCE_ID = "osm-raster";

export function vectorStyleUrl(theme: MapTheme): string {
  return theme === "light" ? publicConfig.mapStyleLight : publicConfig.mapStyleDark;
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
