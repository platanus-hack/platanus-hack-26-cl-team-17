"use client";
/**
 * Marcador HTML de MapLibre con contenido React (portal): botones accesibles con los estilos del
 * sistema de diseño e iconos lucide en línea. El marcador se crea al haber mapa, se mueve con
 * setLngLat cuando cambia la posición (sin recrearse: no pierde el foco) y se quita al desmontar.
 */
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Marker, type Map as MapLibreMap, type PositionAnchor } from "maplibre-gl";
import type { LatLng } from "@/lib/geo";

export interface MapMarkerProps {
  map: MapLibreMap | null;
  position: LatLng;
  anchor?: PositionAnchor;
  draggable?: boolean;
  onDrag?: (p: LatLng) => void;
  onDragEnd?: (p: LatLng) => void;
  /** Orden de apilamiento entre marcadores (mayor = encima). */
  zIndex?: number;
  children: ReactNode;
}

export function MapMarker({
  map,
  position,
  anchor = "center",
  draggable = false,
  onDrag,
  onDragEnd,
  zIndex,
  children,
}: MapMarkerProps) {
  const [element] = useState(() => {
    const el = document.createElement("div");
    el.className = "vg-marker";
    return el;
  });
  const markerRef = useRef<Marker | null>(null);
  const { lat, lng } = position;
  const positionRef = useRef<LatLng>({ lat, lng });

  const emitDrag = useEffectEvent((marker: Marker) => {
    const p = marker.getLngLat();
    onDrag?.({ lat: p.lat, lng: p.lng });
  });
  const emitDragEnd = useEffectEvent((marker: Marker) => {
    const p = marker.getLngLat();
    onDragEnd?.({ lat: p.lat, lng: p.lng });
  });

  useEffect(() => {
    positionRef.current = { lat, lng };
    markerRef.current?.setLngLat([lng, lat]);
  }, [lat, lng]);

  useEffect(() => {
    if (!map) return;
    const p = positionRef.current;
    const marker = new Marker({ element, anchor, draggable, subpixelPositioning: true })
      .setLngLat([p.lng, p.lat])
      .addTo(map);
    const subscriptions = draggable
      ? [marker.on("drag", () => emitDrag(marker)), marker.on("dragend", () => emitDragEnd(marker))]
      : [];
    markerRef.current = marker;
    return () => {
      for (const s of subscriptions) s.unsubscribe();
      marker.remove();
      if (markerRef.current === marker) markerRef.current = null;
    };
  }, [map, element, anchor, draggable]);

  useEffect(() => {
    const el = markerRef.current?.getElement();
    if (el) el.style.zIndex = zIndex === undefined ? "" : String(zIndex);
  }, [zIndex, map]);

  return createPortal(children, element);
}
