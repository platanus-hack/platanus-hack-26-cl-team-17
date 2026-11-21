"use client";
/**
 * Motor del mapa de la ficha. Con NEXT_PUBLIC_MAPBOX_TOKEN usa Mapbox GL JS v3 y el estilo
 * Standard (lightPreset "day", edificios y árboles 3D), cargado desde el CDN de Mapbox para
 * no sumar dependencias. Sin token (o si Mapbox falla) usa MapLibre, ya instalado, con un
 * estilo claro equivalente sobre OpenFreeMap. Las dos APIs son compatibles en lo que usa
 * la ficha (fuentes GeoJSON, capas, marcadores HTML, cámara), así que se tipan como MapLibre.
 */
import "maplibre-gl/dist/maplibre-gl.css";
import { Map as MlMap, Marker as MlMarker, setWorkerUrl, type MarkerOptions } from "maplibre-gl";
import { publicConfig } from "@/lib/public-config";
import { MAP_LOCALE_ES } from "@/components/map/base-style";
import { standardLikeStyle } from "./standard-style";

// MapLibre 6 carga su worker como módulo: con Turbopack hay que darle la URL explícita.
if (typeof window !== "undefined") {
  const workerUrl = new URL("maplibre-gl/dist/maplibre-gl-worker.mjs", import.meta.url);
  setWorkerUrl(new URL(workerUrl.href, window.location.href).href);
}

export type EngineKind = "mapbox" | "maplibre";

export interface MapHandle {
  map: MlMap;
  engine: EngineKind;
  createMarker: (options: MarkerOptions) => MlMarker;
}

export interface CameraInit {
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
}

const MAPBOX_VERSION = "v3.9.0";

interface MapboxGlobal {
  accessToken: string;
  Map: new (options: Record<string, unknown>) => MlMap;
  Marker: new (options: MarkerOptions) => MlMarker;
}

function loadOnce(id: string, create: () => HTMLElement): Promise<void> {
  const existing = document.getElementById(id);
  if (existing) {
    return existing.dataset.loaded === "1"
      ? Promise.resolve()
      : new Promise((res, rej) => {
          existing.addEventListener("load", () => res());
          existing.addEventListener("error", () => rej(new Error(`No cargó ${id}`)));
        });
  }
  return new Promise((res, rej) => {
    const el = create();
    el.id = id;
    el.addEventListener("load", () => {
      el.dataset.loaded = "1";
      res();
    });
    el.addEventListener("error", () => rej(new Error(`No cargó ${id}`)));
    document.head.appendChild(el);
  });
}

async function loadMapbox(): Promise<MapboxGlobal> {
  const base = `https://api.mapbox.com/mapbox-gl-js/${MAPBOX_VERSION}`;
  await Promise.all([
    loadOnce("mapbox-gl-css", () => Object.assign(document.createElement("link"), { rel: "stylesheet", href: `${base}/mapbox-gl.css` })),
    loadOnce("mapbox-gl-js", () => Object.assign(document.createElement("script"), { src: `${base}/mapbox-gl.js`, async: true })),
  ]);
  const g = (window as unknown as { mapboxgl?: MapboxGlobal }).mapboxgl;
  if (!g) throw new Error("Mapbox GL no quedó disponible");
  return g;
}

export async function createMap(container: HTMLElement, cam: CameraInit): Promise<MapHandle> {
  const token = publicConfig.mapboxToken;
  if (token) {
    try {
      const mapboxgl = await loadMapbox();
      mapboxgl.accessToken = token;
      const map = new mapboxgl.Map({
        container,
        style: "mapbox://styles/mapbox/standard",
        config: { basemap: { lightPreset: "day", show3dObjects: true, showPointOfInterestLabels: false, showTransitLabels: false } },
        language: "es",
        ...cam,
        antialias: true,
        attributionControl: true,
      });
      return { map, engine: "mapbox", createMarker: (o) => new mapboxgl.Marker(o) };
    } catch (err) {
      console.warn("[ficha] Mapbox no disponible, se usa MapLibre:", err);
    }
  }
  const map = new MlMap({
    container,
    style: standardLikeStyle(),
    ...cam,
    maxPitch: 75,
    maplibreLogo: false,
    locale: MAP_LOCALE_ES,
    attributionControl: { compact: true },
    fadeDuration: 150,
    // Bordes suaves en las maquetas 3D (casas y vehículos), como en Mapbox.
    canvasContextAttributes: { antialias: true },
  });
  return { map, engine: "maplibre", createMarker: (o) => new MlMarker(o) };
}
