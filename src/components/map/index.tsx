"use client";
/**
 * Mapas de Vigía (MapLibre GL). Se importan desde cualquier componente de cliente: el código de
 * MapLibre se descarga solo en el navegador (next/dynamic con ssr:false) y mientras tanto se ve
 * un esqueleto del mismo tamaño. Props en ./types (contrato).
 */
import dynamic from "next/dynamic";
import { MapFrame, MapLoading } from "./frame";
import type { LocationPickerProps, MiniMapProps, OverviewMapProps, TacticalMapProps } from "./types";
export type { LocationPickerProps, MiniMapProps, OverviewMapProps, TacticalMapProps, MapTheme } from "./types";

const TacticalMapCanvas = dynamic(() => import("./tactical-map"), { ssr: false, loading: MapLoading });
const OverviewMapCanvas = dynamic(() => import("./overview-map"), { ssr: false, loading: MapLoading });
const LocationPickerCanvas = dynamic(() => import("./location-picker"), { ssr: false, loading: MapLoading });
const MiniMapCanvas = dynamic(() => import("./mini-map"), { ssr: false, loading: MapLoading });

/** Mapa táctico de un incidente (cámaras, escena de la IA, drones). Alto por defecto 28rem. */
export function TacticalMap(props: TacticalMapProps) {
  const name = props.incident.title.trim() || props.incident.address.trim() || "incidente";
  return (
    <MapFrame theme={props.theme} className={props.className} defaultSize="h-[28rem] w-full" label={`Mapa táctico: ${name}`}>
      <TacticalMapCanvas {...props} />
    </MapFrame>
  );
}

/** Mapa general con todos los incidentes. Alto por defecto 20rem. */
export function OverviewMap(props: OverviewMapProps) {
  return (
    <MapFrame theme={props.theme} className={props.className} defaultSize="h-80 w-full" label="Mapa de incidentes">
      <OverviewMapCanvas {...props} />
    </MapFrame>
  );
}

/** Selector de ubicación con pin arrastrable. Alto por defecto 16rem. */
export function LocationPicker(props: LocationPickerProps) {
  return (
    <MapFrame
      theme={props.theme}
      className={["rounded-md border border-line", props.className ?? "h-64 w-full"].join(" ")}
      defaultSize="h-64 w-full"
      label="Mapa para marcar la ubicación"
    >
      <LocationPickerCanvas {...props} />
    </MapFrame>
  );
}

/** Mapa pequeño de solo lectura (salvo interactive). Alto por defecto 10rem. */
export function MiniMap(props: MiniMapProps) {
  return (
    <MapFrame theme={props.theme} className={props.className} defaultSize="h-40 w-full" label="Mapa de ubicación">
      <MiniMapCanvas {...props} />
    </MapFrame>
  );
}
