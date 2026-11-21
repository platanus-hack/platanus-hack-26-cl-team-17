"use client";
/**
 * Mapa pequeño, de solo lectura por defecto, con marcadores simples por tono. Se carga solo en
 * el navegador (ver index.tsx). Sigue a `center`/`zoom` cuando cambian; si es interactivo,
 * conserva el zoom que eligió la persona mientras el llamador no cambie `zoom`.
 */
import { useEffect, useRef } from "react";
import { isValidLatLng } from "@/lib/geo";
import { publicConfig } from "@/lib/public-config";
import { cn } from "@/lib/cn";
import { formatLatLng, shortText } from "./labels";
import { BaseMapNotice, LoadingVeil, MapFatalError, TONE_BG, ZoomControls, type Tone } from "./map-chrome";
import { MapMarker } from "./map-marker";
import type { MiniMapProps } from "./types";
import { useMapLibre } from "./use-maplibre";

const DEFAULT_ZOOM = 15;

type MiniMarker = NonNullable<MiniMapProps["markers"]>[number];

function MiniMarkerDot({ marker }: { marker: MiniMarker }) {
  const tone: Tone = marker.tone ?? "accent";
  const label = marker.label?.trim();
  return (
    <span role="img" aria-label={label || "Punto en el mapa"} className="relative grid place-items-center">
      {tone === "critical" && <span aria-hidden className="absolute size-6 animate-ping rounded-full bg-critical/40" />}
      <span
        aria-hidden
        className={cn(
          "relative block size-4 rounded-full border-2 shadow-md",
          TONE_BG[tone],
          tone === "neutral" ? "border-surface" : "border-bg",
        )}
      />
      {label && (
        <span
          aria-hidden
          className="absolute left-1/2 top-full mt-0.5 -translate-x-1/2 whitespace-nowrap rounded bg-surface/90 px-1 text-[10px] font-semibold leading-4 text-text shadow"
        >
          {shortText(label, 18)}
        </span>
      )}
    </span>
  );
}

export default function MiniMapCanvas({ center, zoom = DEFAULT_ZOOM, markers, theme = "dark", interactive = false }: MiniMapProps) {
  const ok = isValidLatLng(center.lat, center.lng);
  const c = ok ? center : publicConfig.defaultCenter;
  const handle = useMapLibre({ theme, center: c, zoom, interactive, compactAttribution: true, minZoom: 2 });
  const { map, containerRef, controller, base, error, loaded } = handle;

  const { lat, lng } = c;
  const shownRef = useRef({ lat, lng, zoom });
  useEffect(() => {
    if (!map) return;
    const prev = shownRef.current;
    if (prev.lat === lat && prev.lng === lng && prev.zoom === zoom) return;
    shownRef.current = { lat, lng, zoom };
    const keepUserZoom = interactive && prev.zoom === zoom;
    controller.flyTo({ lat, lng }, keepUserZoom ? undefined : zoom);
  }, [map, controller, lat, lng, zoom, interactive]);

  const points = (markers ?? []).filter((m) => isValidLatLng(m.lat, m.lng));

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="absolute inset-0" />

      {points.map((m, i) => (
        <MapMarker
          key={`${i}-${m.label ?? ""}`}
          map={map}
          position={{ lat: m.lat, lng: m.lng }}
          zIndex={m.tone === "critical" ? 20 : 10}
        >
          <MiniMarkerDot marker={m} />
        </MapMarker>
      ))}

      <LoadingVeil show={!error && !loaded} />
      {error && <MapFatalError message="Mapa no disponible en este navegador." detail={ok ? formatLatLng(c) : undefined} />}

      {!error && (
        <>
          {interactive && (
            <div className="pointer-events-none absolute right-2 top-2">
              <ZoomControls map={map} />
            </div>
          )}
          <div className="pointer-events-none absolute bottom-1.5 left-1.5">
            <BaseMapNotice base={base} />
          </div>
        </>
      )}
    </div>
  );
}
