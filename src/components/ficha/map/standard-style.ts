/**
 * Estilo claro inspirado en Mapbox Standard (tema "day") para MapLibre, sobre las
 * teselas vectoriales de OpenFreeMap (esquema OpenMapTiles, sin API key):
 * edificios extruidos crema mate, parques verde suave, calles gris azulado, agua
 * celeste y nombres de calle en mayúsculas espaciadas siguiendo la calle.
 * Si hay token de Mapbox, la ficha usa el estilo Standard real (ver engine.ts).
 */
import type { StyleSpecification } from "maplibre-gl";

export const FICHA_MAP = {
  land: "#F4F1EC",
  residential: "#EEEBE5",
  commercial: "#EDE6E3",
  industrial: "#E6E6EA",
  school: "#EFEBDD",
  hospital: "#EFE3E4",
  park: "#CFE3C4",
  wood: "#C2DAB5",
  pitch: "#C9E0BF",
  water: "#A9CBE0",
  road: "#FFFFFF",
  roadMajor: "#FFFFFF",
  roadTrunk: "#F5E4C3",
  casing: "#D3D8DF",
  casingTrunk: "#DCC593",
  rail: "#D5D2CC",
  building: "#E6E2DA",
  buildingFlat: "#E2DED6",
  label: "#7D7A74",
  labelHalo: "#FFFFFF",
  place: "#66645F",
} as const;

/**
 * Edificios en tonos sobrios (piedra, arena gris, gris azulado), con poca saturación:
 * se distinguen entre sí sin competir con los colores que significan algo.
 * Cada edificio toma uno según su id (estable entre cargas).
 */
const BUILDING_TONES = ["#E6E2DA", "#DEDAD2", "#E3DFD6", "#D9DDE2", "#E1DDD3", "#D4D9DF", "#E8E4DD"];
const WARM_TONES = ["#E6E2DA", "#DEDAD2", "#E3DFD6", "#E1DDD3", "#E8E4DD"];
/** Edificios altos (> 25 m): gris acero. */
const TALL_TONES = ["#CFD6DD", "#D6DBE0", "#C9D1D9"];

const SOURCE = "omt";
const FONT_REGULAR = ["Noto Sans Regular"];
const FONT_BOLD = ["Noto Sans Bold"];

/** Ancho de calle por clase y zoom (crece fuerte cerca, como en Standard). */
function roadWidth(base: number) {
  return ["interpolate", ["exponential", 1.6], ["zoom"], 12, base * 0.4, 15, base * 1.6, 18, base * 7, 20, base * 18] as unknown as number;
}

const TRUNK = ["motorway", "trunk"];
const MAJOR = ["primary", "secondary"];
const MINOR = ["tertiary", "minor", "service", "street", "residential", "unclassified"];


/** Paleta nocturna (modo oscuro): carbones de la portada, calles gris pizarra y agua azul profundo. */
export const FICHA_MAP_DARK: { [K in keyof typeof FICHA_MAP]: string } = {
  land: "#141C26",
  residential: "#172030",
  commercial: "#1A2230",
  industrial: "#192029",
  school: "#1A2229",
  hospital: "#22202A",
  park: "#16281F",
  wood: "#142519",
  pitch: "#17291F",
  water: "#0C2236",
  road: "#2A3542",
  roadMajor: "#34414F",
  roadTrunk: "#4A3A2A",
  casing: "#1E2732",
  casingTrunk: "#5A4430",
  rail: "#2A333D",
  building: "#222C38",
  buildingFlat: "#202A35",
  label: "#9AA4AF",
  labelHalo: "#141C26",
  place: "#C3CAD2",
};
const BUILDING_TONES_DARK = ["#232D39", "#26303C", "#212B36", "#283240", "#242E3A", "#2A3442", "#202A35"];
const WARM_TONES_DARK = ["#262C34", "#2A2F36", "#252B33", "#282E35", "#23292F"];
const TALL_TONES_DARK = ["#2E3A48", "#33404E", "#2B3644"];

/** ¿La app está en modo oscuro? (atributo data-modo en <html>). */
export function isModoOscuro(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.modo === "oscuro";
}

export function standardLikeStyle(): StyleSpecification {
  const dark = isModoOscuro();
  const P = dark ? FICHA_MAP_DARK : FICHA_MAP;
  const BT = dark ? BUILDING_TONES_DARK : BUILDING_TONES;
  const WT = dark ? WARM_TONES_DARK : WARM_TONES;
  const TT = dark ? TALL_TONES_DARK : TALL_TONES;
  return {
    version: 8,
    name: "Vigía · ficha (estilo claro)",
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    sources: {
      // Relieve sombreado de Natural Earth (solo a escala país: hasta zoom 6).
      relief: {
        type: "raster",
        tiles: ["https://tiles.openfreemap.org/natural_earth/ne2sr/{z}/{x}/{y}.png"],
        tileSize: 256,
        maxzoom: 6,
        attribution: '<a href="https://www.naturalearthdata.com" target="_blank" rel="noopener noreferrer">Natural Earth</a>',
      },
      [SOURCE]: {
        type: "vector",
        url: "https://tiles.openfreemap.org/planet",
        attribution:
          '<a href="https://openfreemap.org" target="_blank" rel="noopener noreferrer">OpenFreeMap</a> · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap</a>',
      },
    },
    // Luz baja desde el noroeste: caras de los edificios con sombreado suave.
    light: { anchor: "viewport", color: "#FFFFFF", intensity: 0.28, position: [1.4, 210, 35] },
    layers: [
      { id: "land", type: "background", paint: { "background-color": P.land } },
      {
        id: "relief",
        type: "raster",
        source: "relief",
        maxzoom: 9,
        paint: {
          "raster-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0.55, 7, 0.25, 9, 0],
          "raster-saturation": -0.35,
          "raster-contrast": -0.1,
        },
      },
      {
        id: "residential",
        type: "fill",
        source: SOURCE,
        "source-layer": "landuse",
        filter: ["in", ["get", "class"], ["literal", ["residential", "suburb", "neighbourhood"]]],
        paint: { "fill-color": P.residential },
      },
      {
        id: "landuse-commercial",
        type: "fill",
        source: SOURCE,
        "source-layer": "landuse",
        filter: ["in", ["get", "class"], ["literal", ["commercial", "retail"]]],
        paint: { "fill-color": P.commercial },
      },
      {
        id: "landuse-industrial",
        type: "fill",
        source: SOURCE,
        "source-layer": "landuse",
        filter: ["in", ["get", "class"], ["literal", ["industrial", "railway", "garages"]]],
        paint: { "fill-color": P.industrial },
      },
      {
        id: "landuse-school",
        type: "fill",
        source: SOURCE,
        "source-layer": "landuse",
        filter: ["in", ["get", "class"], ["literal", ["school", "university", "college", "kindergarten"]]],
        paint: { "fill-color": P.school },
      },
      {
        id: "landuse-hospital",
        type: "fill",
        source: SOURCE,
        "source-layer": "landuse",
        filter: ["==", ["get", "class"], "hospital"],
        paint: { "fill-color": P.hospital },
      },
      {
        id: "wood",
        type: "fill",
        source: SOURCE,
        "source-layer": "landcover",
        filter: ["in", ["get", "class"], ["literal", ["wood", "forest"]]],
        paint: { "fill-color": P.wood },
      },
      {
        id: "grass",
        type: "fill",
        source: SOURCE,
        "source-layer": "landcover",
        filter: ["in", ["get", "class"], ["literal", ["grass", "farmland", "scrub"]]],
        paint: { "fill-color": P.park, "fill-opacity": 0.8 },
      },
      {
        id: "park",
        type: "fill",
        source: SOURCE,
        "source-layer": "park",
        paint: { "fill-color": P.park },
      },
      {
        id: "pitch",
        type: "fill",
        source: SOURCE,
        "source-layer": "landuse",
        filter: ["in", ["get", "class"], ["literal", ["pitch", "playground", "cemetery", "stadium"]]],
        paint: { "fill-color": P.pitch },
      },
      {
        id: "water",
        type: "fill",
        source: SOURCE,
        "source-layer": "water",
        filter: ["!=", ["get", "brunnel"], "tunnel"],
        paint: { "fill-color": P.water },
      },
      {
        id: "waterway",
        type: "line",
        source: SOURCE,
        "source-layer": "waterway",
        paint: { "line-color": P.water, "line-width": ["interpolate", ["linear"], ["zoom"], 12, 1, 18, 6] },
      },
      {
        id: "road-casing-minor",
        type: "line",
        source: SOURCE,
        "source-layer": "transportation",
        filter: ["all", ["in", ["get", "class"], ["literal", MINOR]], ["!=", ["get", "brunnel"], "tunnel"]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": P.casing, "line-gap-width": roadWidth(0.6), "line-width": 1 },
      },
      {
        id: "road-casing-trunk",
        type: "line",
        source: SOURCE,
        "source-layer": "transportation",
        filter: ["all", ["in", ["get", "class"], ["literal", TRUNK]], ["!=", ["get", "brunnel"], "tunnel"]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": P.casingTrunk, "line-gap-width": roadWidth(1.3), "line-width": 1.2 },
      },
      {
        id: "road-casing-major",
        type: "line",
        source: SOURCE,
        "source-layer": "transportation",
        filter: ["all", ["in", ["get", "class"], ["literal", MAJOR]], ["!=", ["get", "brunnel"], "tunnel"]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": P.casing, "line-gap-width": roadWidth(1.1), "line-width": 1.2 },
      },
      {
        id: "road-minor",
        type: "line",
        source: SOURCE,
        "source-layer": "transportation",
        filter: ["all", ["in", ["get", "class"], ["literal", MINOR]], ["!=", ["get", "brunnel"], "tunnel"]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": P.road, "line-width": roadWidth(0.6) },
      },
      {
        id: "road-major",
        type: "line",
        source: SOURCE,
        "source-layer": "transportation",
        filter: ["all", ["in", ["get", "class"], ["literal", MAJOR]], ["!=", ["get", "brunnel"], "tunnel"]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": P.roadMajor, "line-width": roadWidth(1.1) },
      },
      {
        id: "road-trunk",
        type: "line",
        source: SOURCE,
        "source-layer": "transportation",
        filter: ["all", ["in", ["get", "class"], ["literal", TRUNK]], ["!=", ["get", "brunnel"], "tunnel"]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": P.roadTrunk, "line-width": roadWidth(1.3) },
      },
      {
        id: "path",
        type: "line",
        source: SOURCE,
        "source-layer": "transportation",
        filter: ["==", ["get", "class"], "path"],
        paint: { "line-color": dark ? "#2A3542" : "#E4DED4", "line-width": ["interpolate", ["linear"], ["zoom"], 15, 0.6, 19, 2.5], "line-dasharray": [2, 1.5] },
      },
      {
        id: "rail",
        type: "line",
        source: SOURCE,
        "source-layer": "transportation",
        filter: ["==", ["get", "class"], "rail"],
        paint: { "line-color": P.rail, "line-width": ["interpolate", ["linear"], ["zoom"], 13, 1, 18, 3] },
      },
      {
        id: "building-flat",
        type: "fill",
        source: SOURCE,
        "source-layer": "building",
        maxzoom: 15,
        paint: { "fill-color": P.buildingFlat },
      },
      {
        id: "building-3d",
        type: "fill-extrusion",
        source: SOURCE,
        "source-layer": "building",
        minzoom: 14,
        filter: ["!", ["has", "hide_3d"]],
        paint: {
          // Tono sobrio según el id; los altos en gris acero.
          "fill-extrusion-color": [
            "case",
            [">", ["coalesce", ["get", "render_height"], 0], 25],
            ["match", ["%", ["abs", ["to-number", ["id"], 0]], 3], 0, TT[0], 1, TT[1], TT[2]],
            // Bajos o sin altura (a menudo bloques grandes): solo tonos piedra.
            ["<=", ["coalesce", ["get", "render_height"], 0], 4],
            ["match", ["%", ["abs", ["to-number", ["id"], 0]], WT.length], ...WT.slice(1).flatMap((c, i) => [i + 1, c]), WT[0]],
            ["match", ["%", ["abs", ["to-number", ["id"], 0]], BT.length], ...BT.slice(1).flatMap((c, i) => [i + 1, c]), BT[0]],
          ] as unknown as string,
          // Sin altura conocida: 2 pisos (6 m), lo típico en la ciudad.
          "fill-extrusion-height": ["coalesce", ["get", "render_height"], 6],
          "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
          "fill-extrusion-opacity": ["interpolate", ["linear"], ["zoom"], 14, 0, 15, 0.96],
          "fill-extrusion-vertical-gradient": true,
        },
      },
      {
        id: "boundary-region",
        type: "line",
        source: SOURCE,
        "source-layer": "boundary",
        filter: ["all", ["==", ["get", "admin_level"], 4], ["!=", ["get", "maritime"], 1]],
        paint: { "line-color": dark ? "#3A4654" : "#B7B2A8", "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.5, 10, 1.2], "line-dasharray": [3, 2] },
      },
      {
        id: "boundary-country",
        type: "line",
        source: SOURCE,
        "source-layer": "boundary",
        filter: ["all", ["==", ["get", "admin_level"], 2], ["!=", ["get", "maritime"], 1]],
        paint: { "line-color": dark ? "#4A5664" : "#9A958B", "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.8, 10, 2] },
      },
      {
        id: "street-names",
        type: "symbol",
        source: SOURCE,
        "source-layer": "transportation_name",
        minzoom: 14,
        filter: ["in", ["get", "class"], ["literal", [...TRUNK, ...MAJOR, ...MINOR]]],
        layout: {
          "symbol-placement": "line",
          "text-field": ["upcase", ["coalesce", ["get", "name:es"], ["get", "name"]]],
          "text-font": FONT_BOLD,
          "text-size": ["interpolate", ["linear"], ["zoom"], 14, 9, 18, 12.5],
          "text-letter-spacing": 0.18,
          "text-max-angle": 30,
          "symbol-spacing": 320,
          "text-padding": 6,
        },
        paint: { "text-color": P.label, "text-halo-color": P.labelHalo, "text-halo-width": 1.4 },
      },
      {
        id: "place-names",
        type: "symbol",
        source: SOURCE,
        "source-layer": "place",
        filter: ["in", ["get", "class"], ["literal", ["suburb", "neighbourhood", "quarter"]]],
        maxzoom: 16,
        layout: {
          "text-field": ["upcase", ["coalesce", ["get", "name:es"], ["get", "name"]]],
          "text-font": FONT_REGULAR,
          "text-size": 11,
          "text-letter-spacing": 0.25,
        },
        paint: { "text-color": P.place, "text-halo-color": P.labelHalo, "text-halo-width": 1.2 },
      },
      {
        id: "city-names",
        type: "symbol",
        source: SOURCE,
        "source-layer": "place",
        filter: ["in", ["get", "class"], ["literal", ["city", "town"]]],
        maxzoom: 13,
        layout: {
          "text-field": ["coalesce", ["get", "name:es"], ["get", "name"]],
          "text-font": FONT_BOLD,
          "text-size": ["interpolate", ["linear"], ["zoom"], 4, ["match", ["get", "class"], "city", 12, 10], 10, ["match", ["get", "class"], "city", 17, 13]],
          "symbol-sort-key": ["coalesce", ["get", "rank"], 99],
        },
        paint: { "text-color": dark ? "#D4DAE0" : "#4D4B46", "text-halo-color": P.labelHalo, "text-halo-width": 1.4 },
      },
      {
        id: "country-names",
        type: "symbol",
        source: SOURCE,
        "source-layer": "place",
        filter: ["==", ["get", "class"], "country"],
        maxzoom: 7,
        layout: {
          "text-field": ["upcase", ["coalesce", ["get", "name:es"], ["get", "name"]]],
          "text-font": FONT_REGULAR,
          "text-size": 12,
          "text-letter-spacing": 0.3,
        },
        paint: { "text-color": dark ? "#9AA4AF" : "#7D7A74", "text-halo-color": P.labelHalo, "text-halo-width": 1.2 },
      },
    ],
  };
}
