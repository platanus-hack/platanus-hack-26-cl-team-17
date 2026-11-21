"use client";
/**
 * Mapa general del puesto de mando con todos los incidentes. Encuadra todos al cargar y cuando
 * cambia el conjunto de incidentes (no en cada sondeo); el seleccionado se resalta y, si quedó
 * fuera de la vista, el mapa se desplaza hasta él.
 */
import { useEffect, useEffectEvent, useMemo, useRef } from "react";
import { Scan } from "lucide-react";
import type { IncidentSummary } from "@/lib/contract";
import { isValidLatLng, type LatLng } from "@/lib/geo";
import { publicConfig } from "@/lib/public-config";
import { cn } from "@/lib/cn";
import { boundsOf } from "./geojson";
import { INCIDENT_TYPE_ICON } from "./icons";
import { INCIDENT_STATUS_LABEL, INCIDENT_TYPE_LABEL, SEVERITY_LABEL, TRAPPED_LABEL, shortText } from "./labels";
import { BaseMapNotice, LoadingVeil, MapButton, MapFatalError, TONE_SOLID, ZoomControls, type Tone } from "./map-chrome";
import { MapMarker } from "./map-marker";
import type { OverviewMapProps } from "./types";
import { useMapLibre, type MapView } from "./use-maplibre";

const SINGLE_ZOOM = 15;
const MAX_FIT_ZOOM = 15;
const EMPTY_ZOOM = 11;
/** Margen del encuadre: deja ver la etiqueta bajo los marcadores de los bordes. */
const FIT_PADDING = 96;

export function incidentTone(i: Pick<IncidentSummary, "status" | "severity" | "trapped_status">): {
  tone: Tone;
  pulse: boolean;
} {
  if (i.status === "closed") return { tone: "neutral", pulse: false };
  const trappedHot = i.trapped_status === "confirmed" || i.trapped_status === "probable";
  if (trappedHot || i.severity === "critical") return { tone: "critical", pulse: i.status === "active" };
  if (i.status === "controlled") return { tone: "ok", pulse: false };
  if (i.trapped_status === "possible" || i.severity === "high") return { tone: "accent", pulse: false };
  if (i.severity === "moderate") return { tone: "warning", pulse: false };
  if (i.severity === "low") return { tone: "info", pulse: false };
  return { tone: "neutral", pulse: false };
}

const LABEL_MAX = 22;
const NO_HIDDEN: ReadonlySet<string> = new Set();

/** Prioridad para conservar la etiqueta cuando dos chocan: seleccionado > crítico > activo > resto. */
function labelPriority(i: IncidentSummary, selectedId: string | null | undefined): number {
  if (i.id === selectedId) return 4;
  if (i.status === "closed") return 0;
  if (incidentTone(i).tone === "critical") return 3;
  return i.status === "active" ? 2 : 1;
}

/**
 * Etiquetas que se ocultan porque chocarían con otra de mayor prioridad (el marcador sigue
 * visible y su texto completo está en aria-label). Caja aproximada bajo el marcador.
 */
export function labelsToHide(view: MapView, incidents: readonly IncidentSummary[], selectedId: string | null | undefined) {
  const order = [...incidents].sort((a, b) => labelPriority(b, selectedId) - labelPriority(a, selectedId));
  const kept: { x1: number; x2: number; y1: number; y2: number }[] = [];
  const hidden = new Set<string>();
  for (const i of order) {
    const p = view.project({ lat: i.lat, lng: i.lng });
    const half = Math.min(160, shortText(i.title || i.code, LABEL_MAX).length * 6.2 + 14) / 2;
    const box = { x1: p.x - half, x2: p.x + half, y1: p.y + 20, y2: p.y + 40 };
    const collides = kept.some((k) => box.x1 < k.x2 && box.x2 > k.x1 && box.y1 < k.y2 && box.y2 > k.y1);
    if (collides) hidden.add(i.id);
    else kept.push(box);
  }
  return hidden.size ? hidden : NO_HIDDEN;
}

function incidentAriaLabel(i: IncidentSummary): string {
  return [
    `${INCIDENT_TYPE_LABEL[i.type]}: ${i.title || i.code}`,
    i.address,
    `Código ${i.code}`,
    INCIDENT_STATUS_LABEL[i.status],
    i.severity ? `Severidad ${SEVERITY_LABEL[i.severity].toLowerCase()}` : "Severidad sin evaluar",
    i.trapped_status ? `Personas atrapadas: ${TRAPPED_LABEL[i.trapped_status].toLowerCase()}` : "",
    i.verified ? "" : "Sin verificar",
  ]
    .filter(Boolean)
    .join(". ");
}

function OverviewMarker({
  incident: i,
  selected,
  showLabel,
  onSelect,
}: {
  incident: IncidentSummary;
  selected: boolean;
  showLabel: boolean;
  onSelect?: (id: string) => void;
}) {
  const { tone, pulse } = incidentTone(i);
  const Icon = INCIDENT_TYPE_ICON[i.type];
  const trapped = i.trapped_status === "confirmed" || i.trapped_status === "probable" || i.trapped_status === "possible";
  const label = incidentAriaLabel(i);
  const body = (
    <>
      {pulse && <span aria-hidden className="absolute inset-0 animate-ping rounded-full bg-critical/50" />}
      <span
        className={cn(
          "relative grid size-9 place-items-center rounded-full border-2 shadow-lg transition-transform pointer-coarse:size-11",
          TONE_SOLID[tone],
          selected ? "scale-110 border-text ring-4 ring-info/60" : tone === "neutral" ? "border-line-strong" : "border-bg",
          !i.verified && "border-dashed",
          i.status === "closed" && "opacity-60",
        )}
      >
        <Icon className="size-[18px]" aria-hidden />
      </span>
      {trapped && (
        <span
          aria-hidden
          className="absolute -right-1 -top-1 grid size-4 place-items-center rounded-full bg-critical font-mono text-[10px] font-bold text-on-solid ring-2 ring-bg"
        >
          !
        </span>
      )}
      {showLabel && (
        <span
          aria-hidden
          className={cn(
            "absolute left-1/2 top-full mt-1 max-w-[10rem] -translate-x-1/2 truncate whitespace-nowrap rounded bg-surface/90 px-1.5 py-px text-[11px] font-semibold text-text shadow",
            selected && "ring-1 ring-info",
          )}
        >
          {shortText(i.title || i.code, LABEL_MAX)}
        </span>
      )}
    </>
  );
  if (!onSelect) {
    return (
      <span role="img" aria-label={label} title={label} className="relative grid place-items-center rounded-full">
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onSelect(i.id)}
      aria-label={label}
      aria-pressed={selected}
      title={label}
      className="relative grid place-items-center rounded-full"
    >
      {body}
    </button>
  );
}

export default function OverviewMapCanvas({ incidents, selectedId, onSelect, theme = "dark" }: OverviewMapProps) {
  const valid = useMemo(() => incidents.filter((i) => isValidLatLng(i.lat, i.lng)), [incidents]);
  const idsKey = useMemo(() => valid.map((i) => i.id).sort().join("|"), [valid]);
  const points = useMemo<LatLng[]>(() => valid.map((i) => ({ lat: i.lat, lng: i.lng })), [valid]);

  const handle = useMapLibre({
    theme,
    center: points.length ? points[0] : publicConfig.defaultCenter,
    zoom: points.length === 1 ? SINGLE_ZOOM : EMPTY_ZOOM,
    bounds: points.length > 1 ? boundsOf(points) : null,
    boundsMaxZoom: MAX_FIT_ZOOM,
    boundsPadding: FIT_PADDING,
    trackView: true,
  });
  const { map, containerRef, controller, base, error, loaded, view } = handle;
  const hiddenLabels = useMemo(() => (view ? labelsToHide(view, valid, selectedId) : NO_HIDDEN), [view, valid, selectedId]);

  const frameAll = (animate: boolean) => {
    if (points.length === 0) controller.flyTo(publicConfig.defaultCenter, EMPTY_ZOOM, animate);
    else if (points.length === 1) controller.flyTo(points[0], SINGLE_ZOOM, animate);
    else {
      const b = boundsOf(points);
      if (b) controller.fit(b, { maxZoom: MAX_FIT_ZOOM, padding: FIT_PADDING, animate });
    }
  };
  const frameAllFromEffect = useEffectEvent(() => frameAll(true));

  // El primer encuadre lo hace el controlador al crear el mapa; después, solo si cambian los ids.
  const framedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!map) return;
    const previous = framedKeyRef.current;
    framedKeyRef.current = idsKey;
    if (previous !== null && previous !== idsKey) frameAllFromEffect();
  }, [map, idsKey]);

  const revealSelected = useEffectEvent((id: string) => {
    const target = valid.find((i) => i.id === id);
    if (!map || !target) return;
    if (!map.getBounds().contains([target.lng, target.lat])) {
      controller.flyTo({ lat: target.lat, lng: target.lng }, Math.max(map.getZoom(), 13));
    }
  });
  useEffect(() => {
    if (map && selectedId) revealSelected(selectedId);
  }, [map, selectedId]);

  const zIndexOf = (i: IncidentSummary) => {
    if (i.id === selectedId) return 40;
    if (i.status === "closed") return 1;
    return incidentTone(i).tone === "critical" ? 30 : 10;
  };

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="absolute inset-0" />

      {valid.map((i) => (
        <MapMarker key={i.id} map={map} position={{ lat: i.lat, lng: i.lng }} zIndex={zIndexOf(i)}>
          <OverviewMarker
            incident={i}
            selected={i.id === selectedId}
            showLabel={!hiddenLabels.has(i.id)}
            onSelect={onSelect}
          />
        </MapMarker>
      ))}

      <LoadingVeil show={!error && !loaded} />
      {error && <MapFatalError message={error} />}

      {!error && (
        <>
          <div className="pointer-events-none absolute right-2 top-2 flex flex-col items-end gap-1.5">
            <MapButton label="Ver todos" showLabel disabled={!map} onClick={() => frameAll(true)}>
              <Scan className="size-4" aria-hidden />
            </MapButton>
            <ZoomControls map={map} />
          </div>
          <div className="pointer-events-none absolute bottom-2 left-2 flex flex-col items-start gap-1">
            {valid.length === 0 && (
              <span className="rounded-control border border-line bg-surface/90 px-2 py-1 text-xs text-muted shadow-sm">
                {incidents.length === 0 ? "Sin incidentes para mostrar" : "Los incidentes no tienen ubicación válida"}
              </span>
            )}
            {valid.length > 0 && valid.length < incidents.length && (
              <span className="rounded-control border border-warning bg-surface/90 px-2 py-1 text-xs text-warning shadow-sm">
                {incidents.length - valid.length} sin ubicación válida
              </span>
            )}
            <BaseMapNotice base={base} />
          </div>
        </>
      )}
    </div>
  );
}
