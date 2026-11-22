"use client";
/**
 * Mapa 3D de la ficha: mapa real inclinado (pitch 60°, rumbo −20°) con lo que la IA
 * ubicó encima. Casas como maqueta 3D con techo y ventanas (houses3d.ts, el piso del foco
 * encendido), vehículo afectado en naranjo, zonas de peligro
 * como círculos tenues, conos azules de las cámaras de vecinos, ruta de llegada azul y
 * marcadores tipo Mapbox (punto con borde blanco + píldora blanca).
 *
 * Los marcadores son HTML (Marker del motor) y su contenido se dibuja con React por portal.
 * Si dos etiquetas chocan en pantalla, se oculta la de menor prioridad (el punto queda).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { GeoJSONSource, LngLatBoundsLike, Map as MlMap, Marker } from "maplibre-gl";
import type { Feature, FeatureCollection, LineString, Polygon } from "geojson";
import { Compass, LocateFixed, Minus, Plus } from "lucide-react";
import type { MediaView } from "@/lib/contract";
import { cn } from "@/lib/cn";
import type { FichaMap as FichaMapModel, LngLat, MapPin } from "../model";
import { TONE_HEX } from "../tones";
import { createMap, type MapHandle } from "./engine";
import { enableOrbitDrag } from "./orbit-drag";
import type { HouseLayer } from "./houses3d";
import { MapHud } from "./hud";
import { Halo, PinView } from "./pins";
import { SmokeColumn } from "./smoke";

export type MapView = "3d" | "plan";

export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface FichaMapProps {
  model: FichaMapModel;
  view: MapView;
  /** Marcador que pulsa (lo que Vigía está diciendo). */
  focus: string | null;
  padding: Padding;
  media: readonly MediaView[];
  openCamera: string | null;
  onOpenCamera: (pinId: string | null) => void;
  onOpenMedia: (mediaId: string) => void;
  /** Muestra la ruta completa (estado "llegando"). */
  frameRoute: boolean;
  /** Ventana flotante (intercambiada con el video del dron): sin controles ni HUD, se reencuadra al cambiar. */
  mini?: boolean;
  /** Caja del mapa; sin `style` ocupa toda la pantalla. */
  className?: string;
  style?: CSSProperties;
}

const PITCH_3D = 60;
const BEARING_3D = -20;

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

function polygon(ring: LngLat[], props: Record<string, unknown>): Feature<Polygon> {
  return { type: "Feature", properties: props, geometry: { type: "Polygon", coordinates: [ring] } };
}

/** `blocks`: las casas van en prismas porque la maqueta 3D (three.js) no está disponible. */
function collections(model: FichaMapModel, blocks: boolean) {
  const shapes: FeatureCollection = {
    type: "FeatureCollection",
    features: (blocks ? [...model.parts, ...model.houseBlocks] : model.parts).map((p) => ({
      type: "Feature",
      properties: { base: p.base, top: p.top, color: p.color, glass: Boolean(p.glass) },
      geometry: { type: "Polygon", coordinates: p.hole ? [p.ring, [...p.hole].reverse()] : [p.ring] },
    })),
  };
  const zones: FeatureCollection = {
    type: "FeatureCollection",
    features: model.zones.map((z) => polygon(z.ring, { id: z.id, color: TONE_HEX[z.tone] })),
  };
  const cones: FeatureCollection = { type: "FeatureCollection", features: model.cones.map((c) => polygon(c.ring, { id: c.id })) };
  const route: FeatureCollection =
    model.route.length >= 2
      ? { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: model.route } } as Feature<LineString>] }
      : EMPTY;
  const outlines: FeatureCollection = {
    type: "FeatureCollection",
    features: model.outlines.flatMap((o) => [
      { type: "Feature", properties: { kind: "ring", affected: o.affected }, geometry: { type: "LineString", coordinates: o.ring } },
      { type: "Feature", properties: { kind: "front", affected: o.affected }, geometry: { type: "LineString", coordinates: o.front } },
    ]) as Feature<LineString>[],
  };
  return { shapes, zones, cones, route, outlines };
}

/** Caja que encuadra lo táctico (foco y marcadores cercanos) o la ruta completa. */
function frameBounds(model: FichaMapModel, route: boolean): LngLatBoundsLike {
  const pts: LngLat[] = [];
  if (route && model.route.length >= 2) pts.push(...model.route);
  else {
    // Lo táctico: foco, vidas en riesgo, peligros altos y lo afectado. Cámaras, puesto y
    // unidades pueden quedar fuera de cuadro (se ven al alejar).
    if (model.halo) pts.push(model.halo.at);
    for (const p of model.pins) if (p.priority >= 60) pts.push(p.at);
    // Las maquetas (casas vecinas incluidas) solo cuentan si no hay marcadores importantes.
    if (pts.length <= 1) for (const p of model.parts) pts.push(...p.ring);
  }
  if (!pts.length) for (const p of model.pins) pts.push(p.at);
  if (!pts.length) pts.push(model.center);
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of pts) {
    w = Math.min(w, x);
    e = Math.max(e, x);
    s = Math.min(s, y);
    n = Math.max(n, y);
  }
  // ~15 m de margen: con un solo punto no se acerca de más.
  const pad = route ? 0.0004 : 0.00008;
  return [
    [w - pad, s - pad],
    [e + pad, n + pad],
  ];
}

function addOverlays(map: MlMap, model: FichaMapModel, blocks: boolean) {
  const c = collections(model, blocks);
  map.addSource("f-zones", { type: "geojson", data: c.zones });
  map.addSource("f-cones", { type: "geojson", data: c.cones });
  map.addSource("f-route", { type: "geojson", data: c.route });
  map.addSource("f-shapes", { type: "geojson", data: c.shapes });
  map.addSource("f-outlines", { type: "geojson", data: c.outlines });
  map.addLayer({ id: "f-zones-fill", type: "fill", source: "f-zones", paint: { "fill-color": ["get", "color"], "fill-opacity": 0.1 } });
  map.addLayer({ id: "f-zones-line", type: "line", source: "f-zones", paint: { "line-color": ["get", "color"], "line-width": 1.2, "line-opacity": 0.75 } });
  map.addLayer({ id: "f-cones-fill", type: "fill", source: "f-cones", paint: { "fill-color": TONE_HEX.blue, "fill-opacity": 0.1 } });
  map.addLayer({ id: "f-cones-line", type: "line", source: "f-cones", paint: { "line-color": TONE_HEX.blue, "line-width": 1, "line-opacity": 0.4 } });
  map.addLayer({
    id: "f-route-casing",
    type: "line",
    source: "f-route",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#FFFFFF", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 6, 19, 12] },
  });
  map.addLayer({
    id: "f-route",
    type: "line",
    source: "f-route",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": TONE_HEX.blue, "line-width": ["interpolate", ["linear"], ["zoom"], 14, 3.5, 19, 7] },
  });
  // Contorno de la planta en el suelo (afectada continua, vecinas punteadas) y fachada principal.
  map.addLayer({
    id: "f-outline-affected",
    type: "line",
    source: "f-outlines",
    filter: ["all", ["==", ["get", "kind"], "ring"], ["get", "affected"]],
    paint: { "line-color": TONE_HEX.orange, "line-width": 2 },
  });
  map.addLayer({
    id: "f-outline-exposure",
    type: "line",
    source: "f-outlines",
    filter: ["all", ["==", ["get", "kind"], "ring"], ["!", ["get", "affected"]]],
    paint: { "line-color": "#C99A4A", "line-width": 1.5, "line-dasharray": [3, 2] },
  });
  map.addLayer({
    id: "f-outline-front",
    type: "line",
    source: "f-outlines",
    filter: ["==", ["get", "kind"], "front"],
    layout: { "line-cap": "round" },
    paint: { "line-color": "#151A21", "line-width": 4 },
  });
  // Vehículos en prismas (y las casas, solo si la maqueta 3D no cargó): muros translúcidos y piezas opacas.
  const extrusion = (filter: unknown[]) => ({
    type: "fill-extrusion" as const,
    source: "f-shapes",
    filter: filter as never,
    paint: {
      "fill-extrusion-color": ["get", "color"] as never,
      "fill-extrusion-base": ["get", "base"] as never,
      "fill-extrusion-height": ["get", "top"] as never,
      "fill-extrusion-vertical-gradient": false,
    },
  });
  map.addLayer({ id: "f-parts-solid", ...extrusion(["!", ["get", "glass"]]), paint: { ...extrusion([]).paint, "fill-extrusion-opacity": 1 } });
  map.addLayer({ id: "f-parts-glass", ...extrusion(["get", "glass"]), paint: { ...extrusion([]).paint, "fill-extrusion-opacity": 0.42 } });
  hideBaseBuildings(map, model);
}

/** Oculta los edificios del mapa base que caen bajo una maqueta (solo con el estilo propio de MapLibre). */
function hideBaseBuildings(map: MlMap, model: FichaMapModel) {
  if (!map.getLayer("building-3d")) return;
  const base: unknown[] = ["!", ["has", "hide_3d"]];
  if (!model.hideBase.length) {
    map.setFilter("building-3d", base as never);
    return;
  }
  // Se oculta todo edificio base que toque el círculo de una maqueta (distancia 0 = la contiene).
  const near = model.hideBase.map((h) => ["<", ["distance", { type: "Point", coordinates: h.at }], h.r]);
  try {
    map.setFilter("building-3d", ["all", base, ["!", ["any", ...near]]] as never);
  } catch {
    map.setFilter("building-3d", base as never);
  }
}

function updateOverlays(map: MlMap, model: FichaMapModel, blocks: boolean) {
  const c = collections(model, blocks);
  (map.getSource("f-zones") as GeoJSONSource | undefined)?.setData(c.zones);
  (map.getSource("f-cones") as GeoJSONSource | undefined)?.setData(c.cones);
  (map.getSource("f-route") as GeoJSONSource | undefined)?.setData(c.route);
  (map.getSource("f-shapes") as GeoJSONSource | undefined)?.setData(c.shapes);
  (map.getSource("f-outlines") as GeoJSONSource | undefined)?.setData(c.outlines);
  hideBaseBuildings(map, model);
}

interface Slot {
  marker: Marker;
  el: HTMLElement;
}

export default function FichaMap(props: FichaMapProps) {
  const { model, view, focus, padding, media, openCamera, onOpenCamera, onOpenMedia, frameRoute, mini = false, className, style } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [handle, setHandle] = useState<MapHandle | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [bearing, setBearing] = useState(BEARING_3D);
  const slots = useRef(new Map<string, Slot>());
  const [slotEls, setSlotEls] = useState<Record<string, HTMLElement>>({});
  const haloRef = useRef<Slot | null>(null);
  const smokeSlots = useRef(new Map<string, Slot>());
  const [smokeEls, setSmokeEls] = useState<Record<string, HTMLElement>>({});
  const [haloEl, setHaloEl] = useState<HTMLElement | null>(null);
  const modelRef = useRef(model);
  /** Casas 3D (three.js); si no cargan, `blocksRef` las deja en prismas. */
  const houseLayerRef = useRef<HouseLayer | null>(null);
  const blocksRef = useRef(false);
  const paddingRef = useRef(padding);
  const viewRef = useRef(view);
  const frameRouteRef = useRef(frameRoute);
  const onOpenCameraRef = useRef(onOpenCamera);
  useEffect(() => {
    modelRef.current = model;
    paddingRef.current = padding;
    viewRef.current = view;
    frameRouteRef.current = frameRoute;
    onOpenCameraRef.current = onOpenCamera;
  });

  /* ── Crear y destruir el mapa ── */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let alive = true;
    let created: MapHandle | null = null;
    const live = slots.current;
    const liveSmoke = smokeSlots.current;
    createMap(el, { center: modelRef.current.center, zoom: 17.6, pitch: PITCH_3D, bearing: BEARING_3D })
      .then((h) => {
        if (!alive) {
          h.map.remove();
          return;
        }
        created = h;
        h.map.on("load", () => {
          if (!alive) return;
          addOverlays(h.map, modelRef.current, false);
          setReady(true);
          // Las casas en 3D cargan three.js aparte; si algo falla, vuelven los prismas.
          const toBlocks = (err: unknown) => {
            console.warn("[ficha] casas 3D no disponibles, se usan prismas:", err);
            blocksRef.current = true;
            houseLayerRef.current = null;
            if (alive) updateOverlays(h.map, modelRef.current, true);
          };
          import("./houses3d")
            .then(({ addHouseLayer }) => {
              if (!alive || blocksRef.current) return;
              const m = modelRef.current;
              houseLayerRef.current = addHouseLayer(h.map, m.center, m.houses, toBlocks);
            })
            .catch(toBlocks);
        });
        h.map.on("error", (e) => console.warn("[ficha] mapa:", e?.error?.message ?? e));
        h.map.on("rotate", () => setBearing(h.map.getBearing()));
        h.map.on("click", () => onOpenCameraRef.current(null));
        // Clic izquierdo y arrastrar gira la vista en vez de desplazarla.
        const stopOrbit = enableOrbitDrag(h.map);
        h.map.once("remove", stopOrbit);
        const ro = new ResizeObserver(() => h.map.resize());
        ro.observe(el);
        h.map.once("remove", () => ro.disconnect());
        setHandle(h);
      })
      .catch((err) => {
        console.error("[ficha] no se pudo crear el mapa:", err);
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
      for (const s of live.values()) s.marker.remove();
      live.clear();
      for (const s of liveSmoke.values()) s.marker.remove();
      liveSmoke.clear();
      haloRef.current?.marker.remove();
      haloRef.current = null;
      houseLayerRef.current?.remove();
      houseLayerRef.current = null;
      created?.map.remove();
    };
  }, []);

  /* ── Encuadre ── */
  const frame = useCallback(
    (animate: boolean) => {
      const map = handle?.map;
      if (!map) return;
      const v = viewRef.current;
      const p = paddingRef.current;
      const pad = { top: p.top + 40, right: p.right + 40, bottom: p.bottom + 40, left: p.left + 40 };
      const bearingTarget = v === "3d" ? BEARING_3D : 0;
      const cam = map.cameraForBounds(frameBounds(modelRef.current, frameRouteRef.current), { padding: pad, bearing: bearingTarget, maxZoom: 20.4 });
      if (!cam) return;
      // En 3D lo cercano al centro se ve más chico por la inclinación: se acerca un poco más.
      const zoom = Math.min(20.6, (cam.zoom ?? 18.5) + (v === "3d" && !frameRouteRef.current ? 0.35 : 0));
      const opts = { center: cam.center, zoom, bearing: bearingTarget, pitch: v === "3d" ? PITCH_3D : 0 };
      if (animate) map.easeTo({ ...opts, duration: 900 });
      else map.jumpTo(opts);
    },
    [handle],
  );

  // Primer encuadre al cargar, y otra vez si cambia la vista (3D ↔ planta) o el modo llegando.
  useEffect(() => {
    if (ready) frame(false);
  }, [ready, frame]);
  const firstView = useRef(true);
  useEffect(() => {
    if (!ready) return;
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    frame(true);
  }, [view, frameRoute, ready, frame]);
  // Al pasar a la ventana flotante (o volver) el contenedor cambia de tamaño: se ajusta y se reencuadra.
  const lastMini = useRef(mini);
  useEffect(() => {
    if (!ready || lastMini.current === mini) return;
    lastMini.current = mini;
    handle?.map.resize();
    frame(true);
  }, [mini, ready, handle, frame]);

  /* ── Capas propias ── */
  useEffect(() => {
    if (!ready || !handle) return;
    updateOverlays(handle.map, model, blocksRef.current);
    houseLayerRef.current?.update(model.center, model.houses);
  }, [ready, handle, model]);

  /* ── Marcadores ── */
  useEffect(() => {
    if (!ready || !handle) return;
    const live = slots.current;
    const want = new Set(model.pins.map((p) => p.id));
    let changed = false;
    for (const [id, s] of live) {
      if (!want.has(id)) {
        s.marker.remove();
        live.delete(id);
        changed = true;
      }
    }
    for (const p of model.pins) {
      const existing = live.get(p.id);
      if (existing) {
        existing.marker.setLngLat(p.at);
        continue;
      }
      const el = document.createElement("div");
      el.className = "ficha-pin";
      const marker = handle.createMarker({ element: el, anchor: "center" }).setLngLat(p.at).addTo(handle.map);
      live.set(p.id, { marker, el });
      changed = true;
    }
    if (changed) setSlotEls(Object.fromEntries([...live].map(([id, s]) => [id, s.el])));

    // Halo del foco.
    if (model.halo) {
      if (!haloRef.current) {
        const el = document.createElement("div");
        const marker = handle.createMarker({ element: el, anchor: "center" }).setLngLat(model.halo.at).addTo(handle.map);
        haloRef.current = { marker, el };
        setHaloEl(el);
      } else haloRef.current.marker.setLngLat(model.halo.at);
    } else if (haloRef.current) {
      haloRef.current.marker.remove();
      haloRef.current = null;
      setHaloEl(null);
    }
  }, [ready, handle, model]);

  /* ── Humo: marcadores y variables CSS (escala, salida desde el techo, deriva del viento) ── */
  useEffect(() => {
    if (!ready || !handle) return;
    const live = smokeSlots.current;
    const want = new Set(model.smokes.map((k) => k.id));
    let changed = false;
    for (const [id, sl] of live) {
      if (!want.has(id)) {
        sl.marker.remove();
        live.delete(id);
        changed = true;
      }
    }
    for (const k of model.smokes) {
      const existing = live.get(k.id);
      if (existing) {
        existing.marker.setLngLat(k.at);
        continue;
      }
      const el = document.createElement("div");
      el.style.pointerEvents = "none";
      const marker = handle.createMarker({ element: el, anchor: "center" }).setLngLat(k.at).addTo(handle.map);
      live.set(k.id, { marker, el });
      changed = true;
    }
    if (changed) setSmokeEls(Object.fromEntries([...live].map(([id, sl]) => [id, sl.el])));
  }, [ready, handle, model.smokes]);

  useEffect(() => {
    const map = handle?.map;
    if (!ready || !map || !model.smokes.length) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const lat = map.getCenter().lat;
      const mpp = (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** map.getZoom());
      // px por metro, acotado: de lejos el humo no desaparece; de cerca no tapa todo.
      const ppm = Math.min(14, Math.max(1.4, 1 / mpp));
      const tilt = Math.sin((map.getPitch() * Math.PI) / 180);
      const bearing = map.getBearing();
      for (const k of model.smokes) {
        const el = smokeSlots.current.get(k.id)?.el;
        if (!el) continue;
        const drift = k.driftDeg === null ? 0 : Math.sin(((k.driftDeg - bearing) * Math.PI) / 180);
        el.style.setProperty("--smoke-scale", `${ppm.toFixed(2)}px`);
        el.style.setProperty("--smoke-lift", `${(k.base * (1 / mpp) * tilt).toFixed(1)}px`);
        el.style.setProperty("--smoke-rise", `${(26 * ppm).toFixed(1)}px`);
        el.style.setProperty("--smoke-dx", `${(drift * 16 * ppm).toFixed(1)}px`);
      }
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    map.on("move", schedule);
    schedule();
    return () => {
      map.off("move", schedule);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [ready, handle, model.smokes, smokeEls]);

  /* ── Despeje de etiquetas ── */
  const pinsById = useMemo(() => new Map(model.pins.map((p) => [p.id, p])), [model.pins]);
  useEffect(() => {
    const map = handle?.map;
    if (!ready || !map) return;
    let raf = 0;
    const run = () => {
      raf = 0;
      const order = [...pinsById.values()].sort((a, b) => score(b) - score(a));
      const placed: { x: number; y: number; w: number; h: number }[] = [];
      for (const p of order) {
        const slot = slots.current.get(p.id);
        const label = slot?.el.querySelector<HTMLElement>("[data-pin-label]");
        if (!slot || !label) continue;
        const pt = map.project(p.at);
        const w = label.offsetWidth + 6;
        // Etiqueta a la derecha del punto; si choca, a la izquierda; si tampoco cabe, se oculta.
        const right = { x: pt.x + 10, y: pt.y - 18, w, h: 36 };
        const left = { x: pt.x - 10 - w, y: pt.y - 18, w, h: 36 };
        // Lo que queda bajo los paneles laterales cuenta como ocupado.
        const pad = paddingRef.current;
        const maxX = map.getContainer().clientWidth - pad.right + 8;
        const free = (box: typeof right) =>
          box.x >= pad.left - 8 &&
          box.x + box.w <= maxX &&
          !placed.some((b) => box.x < b.x + b.w && box.x + box.w > b.x && box.y < b.y + b.h && box.y + box.h > b.y);
        const forced = p.id === focus || p.id === openCamera;
        // Lo importante (personas, fuego) no se oculta solo por falta de margen: va al lado con más espacio
        // que no choque con otra etiqueta, aunque asome bajo el panel.
        const clear = (box: typeof right) => !placed.some((b) => box.x < b.x + b.w && box.x + box.w > b.x && box.y < b.y + b.h && box.y + box.h > b.y);
        const roomier = maxX - pt.x >= pt.x - pad.left ? "right" : "left";
        const important = forced || p.priority >= 90;
        const side = free(right)
          ? "right"
          : free(left)
            ? "left"
            : important
              ? clear(roomier === "right" ? right : left)
                ? roomier
                : clear(roomier === "right" ? left : right)
                  ? roomier === "right"
                    ? "left"
                    : "right"
                  : forced
                    ? roomier
                    : null
              : null;
        label.dataset.hidden = side ? "false" : "true";
        if (side) {
          label.dataset.side = side;
          placed.push(side === "right" ? right : left);
        }
        slot.el.style.zIndex = String(Math.round(score(p)));
      }
    };
    const score = (p: MapPin) => p.priority + (p.id === focus ? 1000 : 0) + (p.id === openCamera ? 900 : 0);
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(run);
    };
    map.on("move", schedule);
    map.on("resize", schedule);
    schedule();
    const t = window.setTimeout(schedule, 300);
    return () => {
      map.off("move", schedule);
      map.off("resize", schedule);
      if (raf) cancelAnimationFrame(raf);
      window.clearTimeout(t);
    };
  }, [ready, handle, pinsById, slotEls, focus, openCamera]);

  /* ── Lo que Vigía nombra: si está fuera de la vista, se acerca suave ── */
  useEffect(() => {
    const map = handle?.map;
    if (!map || !focus) return;
    const pin = pinsById.get(focus);
    if (!pin) return;
    const pt = map.project(pin.at);
    const { width, height } = map.getContainer().getBoundingClientRect();
    const p = paddingRef.current;
    const inside = pt.x > p.left && pt.x < width - p.right && pt.y > p.top && pt.y < height - p.bottom;
    if (!inside) map.easeTo({ center: pin.at, duration: 800 });
  }, [focus, handle, pinsById]);

  const mediaById = useMemo(() => new Map(media.map((m) => [m.id, m])), [media]);

  return (
    <div className={cn("absolute isolate", !style && "inset-0", className)} style={style}>
      {/* Posición en línea: maplibre-gl.css pone `.maplibregl-map { position: relative }` y, según el orden en que
          cargan las hojas de estilo (en producción va después de Tailwind), ganaría a `absolute` y el mapa quedaría
          de 300 px de alto. El estilo en línea gana siempre. */}
      <div
        ref={containerRef}
        style={{ position: "absolute", inset: 0 }}
        aria-label="Mapa 3D del incidente"
        role="region"
      />
      {failed && (
        <div className="absolute inset-0 grid place-items-center bg-f-wash text-[15px] text-f-muted">Mapa no disponible sin conexión</div>
      )}

      {model.pins.map((p) => {
        const el = slotEls[p.id];
        if (!el) return null;
        return createPortal(
          <PinView
            pin={p}
            pulsing={p.id === focus}
            open={p.id === openCamera}
            media={p.mediaId ? (mediaById.get(p.mediaId) ?? null) : null}
            onToggle={() => onOpenCamera(p.id === openCamera ? null : p.id)}
            onOpenMedia={onOpenMedia}
          />,
          el,
          p.id,
        );
      })}
      {haloEl && model.halo && createPortal(<Halo tone={model.halo.tone} />, haloEl)}
      {model.smokes.map((k) => {
        const el = smokeEls[k.id];
        return el ? createPortal(<SmokeColumn volume={k.volume} color={k.color} />, el, k.id) : null;
      })}

      {!mini && <MapHud map={ready ? (handle?.map ?? null) : null} padding={padding} />}

      {/* Controles mínimos: zoom, brújula, recentrar */}
      {!mini && (
        <div
          className="absolute z-10 flex flex-col overflow-hidden rounded-2xl bg-white/92 shadow-[0_8px_30px_rgb(33_32_28/0.12)] backdrop-blur-md"
          // Sobre el círculo de Vigía (VigiaDock), que va abajo a la derecha del hueco.
          style={{ right: padding.right + 16, bottom: 96 }}
        >
          <MapButton label="Acercar" onClick={() => handle?.map.zoomIn()}>
            <Plus className="size-5" aria-hidden="true" />
          </MapButton>
          <MapButton label="Alejar" onClick={() => handle?.map.zoomOut()}>
            <Minus className="size-5" aria-hidden="true" />
          </MapButton>
          <MapButton label="Orientar al norte" onClick={() => handle?.map.easeTo({ bearing: 0, duration: 500 })}>
            <Compass className="size-5" style={{ transform: `rotate(${-bearing - 45}deg)` }} aria-hidden="true" />
          </MapButton>
          <MapButton label="Recentrar" onClick={() => frame(true)}>
            <LocateFixed className="size-5" aria-hidden="true" />
          </MapButton>
        </div>
      )}
    </div>
  );
}

function MapButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn("grid size-11 place-items-center text-f-ink transition-colors hover:bg-f-wash", "border-b border-f-line last:border-b-0")}
    >
      {children}
    </button>
  );
}
