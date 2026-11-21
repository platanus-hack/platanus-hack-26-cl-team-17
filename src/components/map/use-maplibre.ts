"use client";
/**
 * Ciclo de vida de un mapa MapLibre 6 para React 19.
 *
 * - Un `MapController` (almacén externo) crea y destruye el mapa; el componente se suscribe con
 *   useSyncExternalStore. Montar → crear, desmontar → map.remove(): soporta el doble montaje
 *   de StrictMode sin fugas.
 * - ResizeObserver sobre el contenedor (el mapa vive en pestañas y paneles que cambian de tamaño).
 * - Respaldo del mapa base: estilo vectorial → si su JSON o sus teselas fallan, ráster OSM en
 *   línea → si tampoco hay teselas, fondo liso + aviso "Mapa base no disponible".
 * - `styleRevision` aumenta en cada carga de estilo: las capas propias se vuelven a agregar.
 */
import "maplibre-gl/dist/maplibre-gl.css";
import "./map.css";
import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import {
  Map as MapLibreMap,
  setWorkerUrl,
  type ErrorEvent as MapErrorEvent,
  type GeoJSONSource,
  type LayerSpecification,
  type MapSourceDataEvent,
  type MapStyleImageMissingEvent,
  type StyleSpecification,
} from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import type { LatLng } from "@/lib/geo";
import type { Bounds } from "./geojson";
import { MAP_LOCALE_ES, OVERLAY_PREFIX, rasterFallbackStyle, vectorStyleUrl } from "./base-style";
import { FALLBACK_PALETTE, readPalette, type MapPalette } from "./palette";
import type { MapTheme } from "./types";

// Turbopack emite el worker de MapLibre 6 como archivo estático (`new URL(..., import.meta.url)`);
// sin esto, MapLibre lo busca junto a su propio módulo, que el empaquetador ya movió.
if (typeof window !== "undefined") {
  const workerUrl = new URL("maplibre-gl/dist/maplibre-gl-worker.mjs", import.meta.url);
  setWorkerUrl(new URL(workerUrl.href, window.location.href).href);
}

/** loading → vector | raster; unavailable = sin teselas (fondo liso). */
export type BaseMapState = "loading" | "vector" | "raster" | "unavailable";

export interface MapSnapshot {
  map: MapLibreMap | null;
  /** 0 = sin estilo cargado todavía. Cambia en cada carga de estilo (las capas propias se pierden). */
  styleRevision: number;
  base: BaseMapState;
  /** Error fatal: el mapa no se pudo crear (p. ej. sin WebGL). */
  error: string | null;
  palette: MapPalette;
  /** Solo con `trackView`: proyección de la vista actual; cambia de identidad al terminar cada movimiento. */
  view: MapView | null;
}

/** Vista quieta del mapa (para decisiones en pantalla, como ocultar etiquetas que chocan). */
export interface MapView {
  zoom: number;
  project(p: LatLng): { x: number; y: number };
}

export interface MapInit {
  theme: MapTheme;
  center: LatLng;
  zoom: number;
  /** Encuadre inicial; tiene prioridad sobre center/zoom. */
  bounds?: Bounds | null;
  boundsMaxZoom?: number;
  boundsPadding?: number;
  interactive?: boolean;
  /** true = siempre plegable; false = siempre expandida; sin valor = responsiva. */
  compactAttribution?: boolean;
  /** Pliega la atribución desde el inicio (mapas chicos de solo lectura, que nunca se arrastran). */
  collapseAttribution?: boolean;
  /** Publica `view` en cada fin de movimiento (vuelve a renderizar el componente). */
  trackView?: boolean;
  minZoom?: number;
  maxZoom?: number;
}

export interface FitOptions {
  maxZoom?: number;
  /** Margen máximo en px; se reduce en contenedores chicos. */
  padding?: number;
  animate?: boolean;
}

const STYLE_TIMEOUT_MS = 9000;
const FIRST_TILE_TIMEOUT_MS = 15000;
const TILE_ERRORS_BEFORE_FALLBACK = 3;

const WEBGL_ERROR =
  "Este navegador no pudo iniciar el mapa (WebGL no disponible o desactivado). La información del incidente sigue disponible en los paneles.";

type Attempt = "vector" | "raster";

const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;

export function setMapInteractive(map: MapLibreMap, interactive: boolean) {
  const handlers = [map.scrollZoom, map.boxZoom, map.dragPan, map.keyboard, map.doubleClickZoom, map.touchZoomRotate];
  for (const h of handlers) {
    if (interactive) h.enable();
    else h.disable();
  }
  if (interactive) {
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
  }
  const canvas = map.getCanvas();
  canvas.style.cursor = interactive ? "" : "default";
  // Un mapa de solo lectura no debe ser una parada de tabulación.
  canvas.tabIndex = interactive ? 0 : -1;
}

export class MapController {
  private snapshot: MapSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly init: MapInit;
  private theme: MapTheme;
  private interactive: boolean;
  private map: MapLibreMap | null = null;
  private container: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt: Attempt = "vector";
  private styleReady = false;
  private tilesOk = 0;
  private tileErrors = 0;
  private pendingFit: { bounds: Bounds; options: FitOptions } | null = null;
  /** Último encuadre automático: se repite si el contenedor cambia de tamaño antes de que la persona mueva el mapa. */
  private lastFit: { bounds: Bounds; options: FitOptions } | null = null;
  private userMoved = false;
  /** true mientras el propio controlador mueve el mapa (sus "movestart" no cuentan como gesto). */
  private applying = false;

  constructor(init: MapInit) {
    this.init = init;
    this.theme = init.theme;
    this.interactive = init.interactive ?? true;
    this.snapshot = {
      map: null,
      styleRevision: 0,
      base: "loading",
      error: null,
      palette: FALLBACK_PALETTE[init.theme],
      view: null,
    };
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;

  /** true entre una carga de estilo y el siguiente cambio de estilo: se pueden agregar fuentes y capas. */
  isStyleReady(map: MapLibreMap): boolean {
    return this.styleReady && this.map === map;
  }

  mount(container: HTMLElement) {
    if (this.map) this.unmount();
    this.container = container;
    this.attempt = isOffline() ? "raster" : "vector";
    this.resetCounters();
    const palette = readPalette(container, this.theme);
    let map: MapLibreMap;
    try {
      const { center, zoom } = this.init;
      map = new MapLibreMap({
        container,
        style: this.styleFor(this.attempt, palette),
        center: [center.lng, center.lat],
        zoom,
        minZoom: this.init.minZoom ?? 3,
        maxZoom: this.init.maxZoom ?? 20,
        // Sin valor = responsiva (se pliega en mapas de menos de 640 px al moverlos).
        attributionControl: { compact: this.init.compactAttribution },
        maplibreLogo: false,
        locale: MAP_LOCALE_ES,
        // Mapa siempre al norte y sin inclinación: lectura táctica sin ambigüedad.
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        maxPitch: 0,
        trackResize: false,
        fadeDuration: 120,
      });
    } catch (err) {
      console.warn("[mapa] no se pudo crear el mapa", err);
      this.set({ map: null, styleRevision: 0, base: "unavailable", error: WEBGL_ERROR, palette, view: null });
      return;
    }
    map.getContainer().classList.add("vg-map");
    setMapInteractive(map, this.interactive);
    map.on("style.load", this.onStyleLoad);
    map.on("error", this.onError);
    map.on("sourcedata", this.onSourceData);
    map.on("movestart", this.onMoveStart);
    map.on("styleimagemissing", this.onImageMissing);
    if (this.init.trackView) map.on("moveend", this.onMoveEnd);
    if (this.init.collapseAttribution) map.on("idle", this.onIdleCollapse);
    this.userMoved = false;
    this.lastFit = null;
    this.resizeObserver = new ResizeObserver(() => {
      this.programmatic(() => map.resize());
      if (!this.isVisible()) return;
      if (this.pendingFit) {
        const { bounds, options } = this.pendingFit;
        this.pendingFit = null;
        this.fit(bounds, options);
      } else if (this.lastFit && !this.userMoved) {
        this.fit(this.lastFit.bounds, { ...this.lastFit.options, animate: false });
      }
    });
    this.resizeObserver.observe(container);
    this.map = map;
    // Encuadre inicial después de crear: si el contenedor está oculto se aplica al hacerse visible.
    if (this.init.bounds) this.fit(this.init.bounds, { maxZoom: this.init.boundsMaxZoom, padding: this.init.boundsPadding });
    this.armStyleTimer();
    this.set({ map, styleRevision: 0, base: "loading", error: null, palette, view: this.viewOf(map) });
  }

  /**
   * Encuadra `bounds` con un margen que cabe en el contenedor (MapLibre no se mueve si el margen
   * es mayor que el mapa). Si el contenedor está oculto, queda pendiente hasta que se vea.
   */
  fit(bounds: Bounds, options: FitOptions = {}) {
    const map = this.map;
    if (!map) return;
    const el = this.container;
    if (!el || !this.isVisible()) {
      this.pendingFit = { bounds, options };
      return;
    }
    const max = options.padding ?? 48;
    // Margen por eje: en un panel alto y angosto el horizontal no debe achicar el vertical.
    const side = (size: number) => Math.max(4, Math.min(max, Math.floor(size / 4)));
    const h = side(el.clientWidth);
    const v = side(el.clientHeight);
    this.lastFit = { bounds, options };
    this.userMoved = false;
    this.programmatic(() =>
      map.fitBounds(bounds, {
        padding: { top: v, bottom: v, left: h, right: h },
        maxZoom: options.maxZoom ?? 17,
        duration: options.animate ? 650 : 0,
      }),
    );
  }

  /** Vuela a un punto (o salta si el contenedor está oculto). */
  flyTo(center: LatLng, zoom?: number, animate = true) {
    const map = this.map;
    if (!map) return;
    this.pendingFit = null;
    this.lastFit = null;
    const target = { center: [center.lng, center.lat] as [number, number], zoom: zoom ?? map.getZoom() };
    this.programmatic(() => {
      if (animate && this.isVisible()) map.flyTo({ ...target, duration: 700, essential: false });
      else map.jumpTo(target);
    });
  }

  unmount() {
    this.pendingFit = null;
    this.lastFit = null;
    this.clearTimer();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    const map = this.map;
    this.map = null;
    this.styleReady = false;
    this.container = null;
    if (map) {
      map.off("style.load", this.onStyleLoad);
      map.off("error", this.onError);
      map.off("sourcedata", this.onSourceData);
      map.off("movestart", this.onMoveStart);
      map.off("styleimagemissing", this.onImageMissing);
      map.off("moveend", this.onMoveEnd);
      map.off("idle", this.onIdleCollapse);
      map.remove();
    }
    this.set({ map: null, styleRevision: 0, base: "loading", error: null, view: null });
  }

  setTheme(theme: MapTheme) {
    if (theme === this.theme) return;
    this.theme = theme;
    const map = this.map;
    if (!map) return;
    this.attempt = isOffline() ? "raster" : "vector";
    this.applyStyle(map);
    this.set({ base: "loading" });
  }

  setInteractive(interactive: boolean) {
    if (interactive === this.interactive) return;
    this.interactive = interactive;
    if (this.map) setMapInteractive(this.map, interactive);
  }

  /* ───────────── internos ───────────── */

  private set(patch: Partial<MapSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l();
  }

  private styleFor(attempt: Attempt, palette: MapPalette): StyleSpecification | string {
    return attempt === "vector" ? vectorStyleUrl(this.theme) : rasterFallbackStyle(this.theme, palette);
  }

  private applyStyle(map: MapLibreMap) {
    this.styleReady = false;
    this.resetCounters();
    this.clearTimer();
    map.setStyle(this.styleFor(this.attempt, readPalette(this.container, this.theme)), { diff: false });
    this.armStyleTimer();
  }

  private resetCounters() {
    this.tilesOk = 0;
    this.tileErrors = 0;
  }

  private clearTimer() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Un contenedor oculto (pestaña inactiva) no pide teselas: no se juzga el mapa base hasta que se vea. */
  private isVisible(): boolean {
    const el = this.container;
    return !!el && el.clientWidth > 0 && el.clientHeight > 0;
  }

  private armStyleTimer() {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.map || this.styleReady) return;
      if (this.attempt === "vector") this.fallbackToRaster("el estilo vectorial no respondió a tiempo");
    }, STYLE_TIMEOUT_MS);
  }

  private armTileTimer() {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.map || this.tilesOk > 0) return;
      if (!this.isVisible()) {
        this.armTileTimer();
        return;
      }
      if (this.attempt === "vector") this.fallbackToRaster("las teselas vectoriales no cargaron");
      else this.set({ base: "unavailable" });
    }, FIRST_TILE_TIMEOUT_MS);
  }

  private fallbackToRaster(reason: string) {
    const map = this.map;
    if (!map || this.attempt === "raster") return;
    console.warn(`[mapa] ${reason}; se usa el respaldo ráster de OpenStreetMap`);
    this.attempt = "raster";
    this.applyStyle(map);
  }

  private onStyleLoad = () => {
    this.styleReady = true;
    this.armTileTimer();
    this.set({
      styleRevision: this.snapshot.styleRevision + 1,
      base: this.snapshot.base === "unavailable" ? "unavailable" : this.attempt,
      palette: readPalette(this.container, this.theme),
    });
  };

  private onError = (e: MapErrorEvent) => {
    const sourceId = (e as MapErrorEvent & { sourceId?: unknown }).sourceId;
    if (typeof sourceId === "string") {
      if (sourceId.startsWith(OVERLAY_PREFIX)) return;
      this.tileErrors += 1;
      if (this.tilesOk === 0 && this.tileErrors >= TILE_ERRORS_BEFORE_FALLBACK) {
        if (this.attempt === "vector") this.fallbackToRaster("las teselas vectoriales fallan");
        else if (this.snapshot.base !== "unavailable") this.set({ base: "unavailable" });
      }
      return;
    }
    // Sin fuente asociada y antes de cargar: falló el JSON del estilo.
    if (!this.styleReady && this.attempt === "vector") this.fallbackToRaster("no se pudo descargar el estilo vectorial");
    // Otros errores (glifos, sprites) no impiden usar el mapa.
  };

  private programmatic(move: () => void) {
    this.applying = true;
    try {
      move();
    } finally {
      this.applying = false;
    }
  }

  private onMoveStart = () => {
    if (!this.applying) this.userMoved = true;
  };

  /** Algunos estilos públicos piden íconos que su sprite no trae: uno transparente evita el aviso repetido. */
  private onImageMissing = (e: MapStyleImageMissingEvent) => {
    const map = this.map;
    if (map && !map.hasImage(e.id)) map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
  };

  private viewOf(map: MapLibreMap): MapView | null {
    if (!this.init.trackView) return null;
    const zoom = map.getZoom();
    return {
      zoom,
      project: (p) => {
        const pt = map.project([p.lng, p.lat]);
        return { x: pt.x, y: pt.y };
      },
    };
  }

  private onMoveEnd = () => {
    if (this.map) this.set({ view: this.viewOf(this.map) });
  };

  /** MapLibre muestra la atribución plegable abierta hasta el primer arrastre: aquí se pliega de entrada. */
  private onIdleCollapse = () => {
    const map = this.map;
    const attrib = map?.getContainer().querySelector(".maplibregl-ctrl-attrib.maplibregl-compact");
    if (!map || !attrib) return;
    attrib.classList.remove("maplibregl-compact-show");
    attrib.removeAttribute("open");
    map.off("idle", this.onIdleCollapse);
  };

  private onSourceData = (e: MapSourceDataEvent) => {
    if (!e.tile || typeof e.sourceId !== "string" || e.sourceId.startsWith(OVERLAY_PREFIX)) return;
    this.tilesOk += 1;
    if (this.tilesOk === 1) this.clearTimer();
    if (this.styleReady && this.snapshot.base !== this.attempt) this.set({ base: this.attempt });
  };
}

export interface MapHandle extends MapSnapshot {
  containerRef: RefObject<HTMLDivElement | null>;
  controller: MapController;
  /** El estilo base cargó al menos una vez y las capas propias ya se pueden dibujar. */
  loaded: boolean;
}

/**
 * Crea el mapa en el div de `containerRef` (que debe quedar sin hijos de React).
 * `init` se usa solo al montar; theme e interactive se actualizan en vivo.
 */
export function useMapLibre(init: MapInit): MapHandle {
  const containerRef = useRef<HTMLDivElement>(null);
  const [controller] = useState(() => new MapController(init));
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    controller.mount(el);
    return () => controller.unmount();
  }, [controller]);

  useEffect(() => {
    controller.setTheme(init.theme);
  }, [controller, init.theme]);

  const interactive = init.interactive ?? true;
  useEffect(() => {
    controller.setInteractive(interactive);
  }, [controller, interactive]);

  return { ...snapshot, loaded: snapshot.styleRevision > 0, containerRef, controller };
}

/**
 * Fuente GeoJSON propia con sus capas. Se agrega cuando el estilo está listo (y de nuevo tras cada
 * cambio de estilo) y luego solo se actualizan los datos si cambian: el encuadre no se toca.
 * `layers` debe venir memorizado; sus ids deben empezar con OVERLAY_PREFIX.
 */
export function useGeoJsonOverlay(
  handle: Pick<MapHandle, "map" | "styleRevision" | "controller">,
  id: string,
  data: FeatureCollection,
  layers: readonly LayerSpecification[],
) {
  const { map, styleRevision, controller } = handle;
  const lastRef = useRef<{ map: MapLibreMap; revision: number; json: string } | null>(null);

  useEffect(() => {
    if (!map || styleRevision === 0 || !controller.isStyleReady(map)) return;
    try {
      const json = JSON.stringify(data);
      const source = map.getSource<GeoJSONSource>(id);
      const last = lastRef.current;
      if (!source) {
        map.addSource(id, { type: "geojson", data });
      } else if (!last || last.map !== map || last.revision !== styleRevision || last.json !== json) {
        source.setData(data).catch(() => undefined);
      }
      for (const layer of layers) {
        if (!map.getLayer(layer.id)) map.addLayer(layer);
      }
      lastRef.current = { map, revision: styleRevision, json };
    } catch (err) {
      console.warn(`[mapa] no se pudo actualizar la capa ${id}`, err);
    }
  }, [map, styleRevision, controller, id, data, layers]);
}
