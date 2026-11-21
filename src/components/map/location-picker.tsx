"use client";
/**
 * Selector de ubicación con pin arrastrable. Se carga solo en el navegador (ver index.tsx).
 * Clic/toque en el mapa, arrastre del pin, flechas del teclado sobre el pin o "Usar mi
 * ubicación" emiten onChange. Si `value` cambia desde afuera (búsqueda, GPS del formulario),
 * el mapa vuela hasta ese punto; los cambios hechos aquí no mueven el mapa.
 */
import { useEffect, useEffectEvent, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { LayerSpecification, MapMouseEvent } from "maplibre-gl";
import { CircleAlert, Crosshair, Loader2, LocateFixed, MousePointerClick, X } from "lucide-react";
import { GeoError, getPosition } from "@/lib/client/geo";
import { distanceM, isValidLatLng, type LatLng } from "@/lib/geo";
import { publicConfig } from "@/lib/public-config";
import { cn } from "@/lib/cn";
import { circlePolygon, featureCollection } from "./geojson";
import { formatLatLng, formatMeters } from "./labels";
import { BaseMapNotice, LoadingVeil, MapButton, MapFatalError, ZoomControls } from "./map-chrome";
import { MapMarker } from "./map-marker";
import type { MapPalette } from "./palette";
import type { LocationPickerProps } from "./types";
import { useGeoJsonOverlay, useMapLibre } from "./use-maplibre";

const START_ZOOM = 13;
const PIN_ZOOM = 17;
/** Al volar a un punto externo, al menos este zoom (se ve la cuadra). */
const FLY_MIN_ZOOM = 16;
/** Dos posiciones a menos de esto son la misma (redondeos del formulario). */
const SAME_POINT_M = 0.5;
/** Paso de las flechas sobre el pin, en píxeles de pantalla (Mayús = grande). */
const KEY_STEP_PX = 8;
const KEY_STEP_LARGE_PX = 48;
const ARROWS: Record<string, [number, number]> = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
};

function accuracyLayers(p: MapPalette): LayerSpecification[] {
  return [
    {
      id: "vg-pick-accuracy-fill",
      type: "fill",
      source: "vg-pick-accuracy",
      paint: { "fill-color": p.info, "fill-opacity": 0.12 },
    },
    {
      id: "vg-pick-accuracy-line",
      type: "line",
      source: "vg-pick-accuracy",
      paint: { "line-color": p.info, "line-width": 1, "line-opacity": 0.6 },
    },
  ];
}

/** Pin con la punta exactamente en la posición (anchor "bottom"). */
function PickerPin({ lifted }: { lifted: boolean }) {
  return (
    <>
      <span
        aria-hidden
        className="absolute bottom-0 left-1/2 h-1.5 w-3.5 -translate-x-1/2 translate-y-1/2 rounded-full bg-black/35"
      />
      <svg
        viewBox="0 0 32 44"
        aria-hidden
        className={cn(
          "block h-11 w-8 drop-shadow-[0_2px_3px_rgb(0_0_0/0.45)] transition-transform duration-150",
          lifted && "-translate-y-2",
        )}
      >
        <path
          d="M16 1.5C8 1.5 1.5 7.8 1.5 15.8c0 10.2 12.2 24.4 13.6 26a1.2 1.2 0 0 0 1.8 0c1.4-1.6 13.6-15.8 13.6-26C30.5 7.8 24 1.5 16 1.5z"
          className="fill-accent stroke-bg"
          strokeWidth="2.5"
        />
        <circle cx="16" cy="15.5" r="5.5" className="fill-bg" />
      </svg>
    </>
  );
}

export default function LocationPickerCanvas({ value, onChange, initialCenter, theme = "dark" }: LocationPickerProps) {
  const valid = value && isValidLatLng(value.lat, value.lng) ? value : null;
  const lat = valid?.lat ?? null;
  const lng = valid?.lng ?? null;
  const start =
    valid ?? (initialCenter && isValidLatLng(initialCenter.lat, initialCenter.lng) ? initialCenter : publicConfig.defaultCenter);
  const large = theme === "light";

  const handle = useMapLibre({ theme, center: start, zoom: valid ? PIN_ZOOM : START_ZOOM, compactAttribution: true });
  const { map, containerRef, controller, palette, base, error, loaded } = handle;

  const [dragPos, setDragPos] = useState<LatLng | null>(null);
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [gpsFix, setGpsFix] = useState<{ at: LatLng; accuracyM: number } | null>(null);

  // Último punto emitido aquí: cuando vuelve como `value` no se mueve el mapa.
  const emittedRef = useRef<LatLng | null>(null);
  // Último `value` ya atendido (el inicial ya está centrado al crear el mapa).
  const handledRef = useRef<LatLng | null>(valid);

  const emit = (p: LatLng) => {
    emittedRef.current = p;
    setGeoError(null);
    onChange({ lat: p.lat, lng: p.lng });
  };

  const onMapClick = useEffectEvent((e: MapMouseEvent) => {
    // MapLibre también avisa "click" del mapa cuando se toca un marcador: el pin no se mueve a sí mismo.
    const target = e.originalEvent.target;
    if (target instanceof Element && target.closest(".maplibregl-marker")) return;
    emit({ lat: e.lngLat.lat, lng: e.lngLat.lng });
  });

  useEffect(() => {
    if (!map) return;
    const subscription = map.on("click", (e) => onMapClick(e));
    return () => subscription.unsubscribe();
  }, [map]);

  useEffect(() => {
    if (!map) return;
    if (lat === null || lng === null) {
      handledRef.current = null;
      return;
    }
    const p = { lat, lng };
    const prev = handledRef.current;
    handledRef.current = p;
    if (prev && distanceM(prev, p) < SAME_POINT_M) return;
    const mine = emittedRef.current;
    if (mine && distanceM(mine, p) < SAME_POINT_M) return;
    controller.flyTo(p, Math.max(map.getZoom(), FLY_MIN_ZOOM));
  }, [map, controller, lat, lng]);

  const locate = async () => {
    if (locating) return;
    setLocating(true);
    setGeoError(null);
    try {
      const pos = await getPosition();
      const p = { lat: pos.lat, lng: pos.lng };
      setGpsFix({ at: p, accuracyM: pos.accuracy_m });
      emit(p);
      controller.flyTo(p, Math.max(map?.getZoom() ?? 0, PIN_ZOOM));
    } catch (err) {
      setGeoError(err instanceof GeoError ? err.message : "No pudimos obtener tu ubicación. Marca el lugar en el mapa.");
    } finally {
      setLocating(false);
    }
  };

  const markCenter = () => {
    if (!map) return;
    const c = map.getCenter();
    emit({ lat: c.lat, lng: c.lng });
  };

  const onPinKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const dir = ARROWS[e.key];
    if (!dir || !map || !valid || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    const step = e.shiftKey ? KEY_STEP_LARGE_PX : KEY_STEP_PX;
    const pt = map.project([valid.lng, valid.lat]);
    const next = map.unproject([pt.x + dir[0] * step, pt.y + dir[1] * step]);
    emit({ lat: next.lat, lng: next.lng });
  };

  // La precisión del GPS se muestra mientras el pin siga donde lo dejó "Usar mi ubicación".
  const accuracyM = gpsFix && valid && distanceM(gpsFix.at, valid) < SAME_POINT_M ? gpsFix.accuracyM : null;
  const accuracyData = useMemo(
    () =>
      featureCollection(
        gpsFix && accuracyM !== null && accuracyM >= 3
          ? [circlePolygon(gpsFix.at, Math.min(accuracyM, 3000), {}, 48)]
          : [],
      ),
    [gpsFix, accuracyM],
  );
  const layers = useMemo(() => accuracyLayers(palette), [palette]);
  useGeoJsonOverlay(handle, "vg-pick-accuracy", accuracyData, layers);

  const shown = dragPos ?? valid;
  const icon = large ? "size-5" : "size-4";

  return (
    <div className="vg-map-pick absolute inset-0">
      <div ref={containerRef} className="absolute inset-0" />

      {shown && (
        <MapMarker
          map={map}
          position={shown}
          anchor="bottom"
          draggable
          zIndex={40}
          onDrag={setDragPos}
          onDragEnd={(p) => {
            setDragPos(null);
            emit(p);
          }}
        >
          <button
            type="button"
            onKeyDown={onPinKeyDown}
            aria-label={`Ubicación marcada: ${formatLatLng(shown)}. Arrastra el pin o usa las flechas del teclado para moverlo.`}
            title="Arrastra el pin para ajustar la ubicación"
            className={cn(
              "relative block cursor-grab touch-none rounded-sm px-1.5 pt-1.5 active:cursor-grabbing",
              "pointer-coarse:px-3 pointer-coarse:pt-3",
            )}
          >
            <PickerPin lifted={dragPos !== null} />
          </button>
        </MapMarker>
      )}

      <LoadingVeil show={!error && !loaded} />
      {error && <MapFatalError message={error} detail="Puedes fijar la ubicación con la búsqueda o a mano." />}

      {!error && (
        <>
          <div className="pointer-events-none absolute right-2 top-2 flex flex-col items-end gap-1">
            <MapButton
              label={locating ? "Buscando tu ubicación…" : "Usar mi ubicación"}
              large={large}
              disabled={!map || locating}
              onClick={() => void locate()}
            >
              {locating ? (
                <Loader2 className={cn(icon, "animate-spin")} aria-hidden />
              ) : (
                <LocateFixed className={icon} aria-hidden />
              )}
            </MapButton>
            <ZoomControls map={map} large={large} />
          </div>

          {geoError && (
            <div
              role="alert"
              className="pointer-events-auto absolute left-2 right-14 top-2 flex items-start gap-1.5 rounded-control border border-warning bg-surface/95 px-2 py-1.5 text-xs text-text shadow-md pointer-coarse:right-16"
            >
              <CircleAlert className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
              <span className="min-w-0 flex-1">{geoError}</span>
              <button
                type="button"
                onClick={() => setGeoError(null)}
                aria-label="Cerrar aviso"
                className="-m-1 grid size-6 shrink-0 place-items-center rounded-sm text-muted hover:text-text pointer-coarse:size-8"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </div>
          )}

          <div className="pointer-events-none absolute bottom-2 left-2 right-12 flex flex-col items-start gap-1">
            <BaseMapNotice base={base} />
            {shown ? (
              <span
                aria-live="polite"
                className="inline-flex max-w-full items-center gap-1.5 rounded-control border border-line bg-surface/90 px-2 py-1 font-mono text-[11px] text-text shadow-sm tabular"
              >
                <Crosshair className="size-3.5 shrink-0 text-accent" aria-hidden />
                <span className="truncate">{formatLatLng(shown)}</span>
                {accuracyM !== null && (
                  <span className="shrink-0 font-sans text-muted">· GPS ±{formatMeters(accuracyM)}</span>
                )}
              </span>
            ) : (
              <span className="pointer-events-auto inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-control border border-line bg-surface/90 px-2 py-1 text-xs text-text shadow-sm">
                <span className="inline-flex items-center gap-1.5">
                  <MousePointerClick className="size-3.5 shrink-0 text-accent" aria-hidden />
                  Toca o haz clic en el mapa para marcar el lugar
                </span>
                <button
                  type="button"
                  onClick={markCenter}
                  disabled={!map}
                  className="font-semibold text-info underline-offset-2 hover:underline disabled:opacity-50 pointer-coarse:py-1"
                >
                  Marcar el centro
                </button>
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
