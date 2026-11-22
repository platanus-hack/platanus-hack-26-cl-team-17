"use client";
/**
 * Mapa táctico de UN incidente. Se carga solo en el navegador (ver index.tsx).
 * Las fuentes GeoJSON se actualizan en su lugar en cada sondeo; el encuadre del usuario se
 * conserva (solo "Centrar" o una corrección grande de la ubicación lo cambian).
 */
import { useEffect, useEffectEvent, useMemo, useRef } from "react";
import type { ExpressionSpecification, LayerSpecification } from "maplibre-gl";
import { Flame, LocateFixed, PlaneTakeoff, User, Users } from "lucide-react";
import { distanceM, formatBearing, isValidLatLng, destination, toLatLng, type LatLng } from "@/lib/geo";
import { publicConfig } from "@/lib/public-config";
import {
  RANGE_RINGS_M,
  boundsOf,
  cameraCones,
  cameraPlacements,
  droneOverlays,
  isLocalOk,
  isMissionActive,
  isPersonAtRisk,
  radiusPoints,
  rangeRings,
  sceneHasPeopleAtRisk,
  sceneOverlays,
  validHeading,
  vehicleTone,
  type Bounds,
  type CameraPlacement,
} from "./geojson";
import { ACCESS_ICON, HAZARD_ICON, INCIDENT_TYPE_ICON, VEHICLE_ICON } from "./icons";
import {
  ACCESS_KIND_LABEL,
  CONFIDENCE_LABEL,
  FIRE_INTENSITY_LABEL,
  HAZARD_KIND_LABEL,
  HAZARD_SEVERITY_LABEL,
  INCIDENT_TYPE_LABEL,
  MEDIA_KIND_LABEL,
  MEDIA_SOURCE_LABEL,
  MISSION_STATUS_LABEL,
  STRUCTURE_ROLE_LABEL,
  STRUCTURE_SIDE_LABEL,
  VEHICLE_KIND_LABEL,
  VEHICLE_STATE_LABEL,
  formatLatLng,
  formatMeters,
  personGroupLabel,
} from "./labels";
import { MapLegend, type LegendItem } from "./legend";
import { BaseMapNotice, LoadingVeil, MapButton, MapFatalError, ZoomControls, type Tone } from "./map-chrome";
import { MapMarker } from "./map-marker";
import { CameraMarker, DroneMarker, IncidentMarker, InfoMarker, RingLabel, type TipContent } from "./markers";
import type { MapPalette } from "./palette";
import type { TacticalMapProps } from "./types";
import { useGeoJsonOverlay, useMapLibre } from "./use-maplibre";
import type { AccessPointKind, PersonStatus, SceneModel } from "@/lib/domain";

/** Más lejos que esto (GPS dudoso, dron en tránsito) se dibuja, pero no se usa para encuadrar. */
const FRAME_MAX_DISTANCE_M = 400;
/** Radio mínimo del encuadre inicial: la escena y el anillo de 50 m, con la cuadra alrededor. */
const FRAME_RADIUS_M = 60;
const REFRAME_ON_MOVE_M = 300;
const FRAME_MAX_ZOOM = 18;

function personTone(status: PersonStatus): Tone {
  if (isPersonAtRisk(status)) return "critical";
  if (status === "injured" || status === "unknown") return "warning";
  if (status === "evacuating") return "info";
  return "neutral";
}

function accessTone(kind: AccessPointKind): Tone {
  if (kind === "hydrant") return "info";
  if (kind === "command_post" || kind === "staging") return "ok";
  return "neutral";
}

const floorText = (floor: number) => (Number.isFinite(floor) && floor > 0 ? `Piso ${Math.round(floor)}` : "");
const aiConfidence = (c: SceneModel["confidence"]) => `Confianza ${CONFIDENCE_LABEL[c]} (estimado por IA)`;

function buildLayers(p: MapPalette) {
  const roads: LayerSpecification[] = [
    {
      id: "vg-roads-fill",
      type: "fill",
      source: "vg-roads",
      paint: {
        "fill-color": ["case", ["get", "blocked"], p.critical, p.text],
        "fill-opacity": ["case", ["get", "blocked"], 0.26, 0.06],
      },
    },
    {
      id: "vg-roads-blocked",
      type: "line",
      source: "vg-roads",
      filter: ["==", ["get", "blocked"], true],
      paint: { "line-color": p.critical, "line-width": 1.5, "line-dasharray": [2, 1.5] },
    },
  ];
  const cones: LayerSpecification[] = [
    {
      id: "vg-cones-fill",
      type: "fill",
      source: "vg-cones",
      paint: { "fill-color": p.info, "fill-opacity": ["case", ["get", "estimated"], 0.07, 0.15] },
    },
    {
      id: "vg-cones-line",
      type: "line",
      source: "vg-cones",
      filter: ["==", ["get", "estimated"], false],
      paint: { "line-color": p.info, "line-width": 1, "line-opacity": 0.7 },
    },
    {
      id: "vg-cones-line-estimated",
      type: "line",
      source: "vg-cones",
      filter: ["==", ["get", "estimated"], true],
      paint: { "line-color": p.info, "line-width": 1, "line-opacity": 0.6, "line-dasharray": [2, 2] },
    },
  ];
  const rings: LayerSpecification[] = [
    {
      id: "vg-rings",
      type: "line",
      source: "vg-rings",
      paint: { "line-color": p.muted, "line-width": 1, "line-opacity": 0.75, "line-dasharray": [3, 3] },
    },
  ];
  const hazardColor = (): ExpressionSpecification => ["match", ["get", "severity"], "high", p.critical, p.warning];
  const hazards: LayerSpecification[] = [
    {
      id: "vg-hazards-fill",
      type: "fill",
      source: "vg-hazards",
      paint: { "fill-color": hazardColor(), "fill-opacity": ["match", ["get", "severity"], "high", 0.16, 0.1] },
    },
    {
      id: "vg-hazards-line",
      type: "line",
      source: "vg-hazards",
      paint: { "line-color": hazardColor(), "line-width": 1.5, "line-dasharray": [2, 2] },
    },
  ];
  const roleColor = (): ExpressionSpecification => [
    "match",
    ["get", "role"],
    "involved",
    p.accent,
    "exposure",
    p.warning,
    p.muted,
  ];
  const structures: LayerSpecification[] = [
    {
      id: "vg-structures-fill",
      type: "fill",
      source: "vg-structures",
      paint: {
        "fill-color": roleColor(),
        "fill-opacity": ["match", ["get", "role"], "involved", 0.36, "exposure", 0.24, 0.12],
      },
    },
    {
      id: "vg-structures-line",
      type: "line",
      source: "vg-structures",
      filter: ["==", ["get", "low_confidence"], false],
      paint: { "line-color": roleColor(), "line-width": 1.5 },
    },
    {
      id: "vg-structures-line-low",
      type: "line",
      source: "vg-structures",
      filter: ["==", ["get", "low_confidence"], true],
      paint: { "line-color": roleColor(), "line-width": 1.5, "line-dasharray": [2, 1.5] },
    },
  ];
  const facades: LayerSpecification[] = [
    {
      id: "vg-facades",
      type: "line",
      source: "vg-facades",
      layout: { "line-cap": "round" },
      paint: { "line-color": p.text, "line-width": 3.5, "line-opacity": 0.85 },
    },
  ];
  const vehicleColor = (): ExpressionSpecification => [
    "match",
    ["get", "tone"],
    "critical",
    p.critical,
    "accent",
    p.accent,
    p.muted,
  ];
  const vehicles: LayerSpecification[] = [
    {
      id: "vg-vehicles-fill",
      type: "fill",
      source: "vg-vehicles",
      paint: { "fill-color": vehicleColor(), "fill-opacity": 0.55 },
    },
    {
      id: "vg-vehicles-line",
      type: "line",
      source: "vg-vehicles",
      paint: { "line-color": vehicleColor(), "line-width": 1.5 },
    },
  ];
  const fires: LayerSpecification[] = [
    {
      id: "vg-fires-fill",
      type: "fill",
      source: "vg-fires",
      paint: {
        "fill-color": ["match", ["get", "intensity"], "smoke_only", p.muted, p.accent],
        "fill-opacity": ["match", ["get", "intensity"], "heavy", 0.6, "moderate", 0.48, "light", 0.36, 0.25],
      },
    },
    {
      id: "vg-fires-line",
      type: "line",
      source: "vg-fires",
      paint: {
        "line-color": ["match", ["get", "intensity"], "smoke_only", p.muted, p.accent],
        "line-width": 1.5,
      },
    },
  ];
  const droneRoutes: LayerSpecification[] = [
    {
      id: "vg-drone-routes",
      type: "line",
      source: "vg-drone-routes",
      paint: { "line-color": p.drone, "line-width": 1.5, "line-opacity": 0.4, "line-dasharray": [1, 2] },
    },
  ];
  const droneWaypoints: LayerSpecification[] = [
    {
      id: "vg-drone-waypoints",
      type: "circle",
      source: "vg-drone-waypoints",
      paint: { "circle-radius": 2.5, "circle-color": p.drone, "circle-opacity": 0.45 },
    },
  ];
  const droneTracks: LayerSpecification[] = [
    {
      id: "vg-drone-tracks",
      type: "line",
      source: "vg-drone-tracks",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": p.drone, "line-width": 2.5, "line-opacity": ["case", ["get", "active"], 0.9, 0.4] },
    },
  ];
  return { roads, cones, rings, hazards, structures, facades, vehicles, fires, droneRoutes, droneWaypoints, droneTracks };
}

function cameraTip(c: CameraPlacement): TipContent {
  const heading =
    c.heading === null
      ? "Rumbo desconocido"
      : `Mira hacia ${formatBearing(c.heading)}${c.estimatedHeading ? " (estimado por IA)" : ""}`;
  return {
    title: `${c.label}: ${MEDIA_KIND_LABEL[c.kind]} ${MEDIA_SOURCE_LABEL[c.source]}`,
    lines: [
      heading,
      c.estimatedPosition ? "Posición estimada por IA (el medio no traía GPS)" : "Posición GPS del teléfono",
      c.distanceM > 0 ? `A ${formatMeters(c.distanceM)} del incidente` : "",
    ],
  };
}

export default function TacticalMapCanvas({
  incident,
  scene,
  media,
  missions,
  theme = "dark",
  onOpenMedia,
}: TacticalMapProps) {
  const { lat, lng } = incident;
  const originOk = isValidLatLng(lat, lng);
  const origin = useMemo<LatLng>(() => ({ lat, lng }), [lat, lng]);
  const drawableScene = originOk ? scene : null;

  const cameras = useMemo(() => cameraPlacements(origin, media, drawableScene), [origin, media, drawableScene]);
  const overlays = useMemo(() => sceneOverlays(origin, drawableScene), [origin, drawableScene]);
  const rings = useMemo(() => (originOk ? rangeRings(origin) : rangeRings(origin, [])), [origin, originOk]);
  const cones = useMemo(() => cameraCones(cameras), [cameras]);
  const drones = useMemo(() => droneOverlays(missions), [missions]);
  const atRisk = sceneHasPeopleAtRisk(drawableScene);

  const frameBounds = useMemo<Bounds | null>(() => {
    if (!originOk) return null;
    const pts: LatLng[] = [...radiusPoints(origin, FRAME_RADIUS_M)];
    for (const c of cameras) if (c.distanceM <= FRAME_MAX_DISTANCE_M) pts.push(c.position);
    for (const m of missions) {
      if (m.last && isMissionActive(m.status) && distanceM(origin, m.last) <= FRAME_MAX_DISTANCE_M) pts.push(m.last);
    }
    return boundsOf(pts);
  }, [origin, originOk, cameras, missions]);

  const handle = useMapLibre({
    theme,
    center: originOk ? origin : publicConfig.defaultCenter,
    zoom: originOk ? 17 : 11,
    bounds: frameBounds,
    boundsMaxZoom: FRAME_MAX_ZOOM,
  });
  const { map, containerRef, controller, palette, base, error, loaded } = handle;
  const layers = useMemo(() => buildLayers(palette), [palette]);

  // Orden de dibujo: de abajo hacia arriba.
  useGeoJsonOverlay(handle, "vg-roads", overlays.roads, layers.roads);
  useGeoJsonOverlay(handle, "vg-cones", cones, layers.cones);
  useGeoJsonOverlay(handle, "vg-rings", rings, layers.rings);
  useGeoJsonOverlay(handle, "vg-hazards", overlays.hazards, layers.hazards);
  useGeoJsonOverlay(handle, "vg-structures", overlays.structures, layers.structures);
  useGeoJsonOverlay(handle, "vg-facades", overlays.facades, layers.facades);
  useGeoJsonOverlay(handle, "vg-vehicles", overlays.vehicles, layers.vehicles);
  useGeoJsonOverlay(handle, "vg-fires", overlays.fires, layers.fires);
  useGeoJsonOverlay(handle, "vg-drone-routes", drones.routes, layers.droneRoutes);
  useGeoJsonOverlay(handle, "vg-drone-waypoints", drones.waypoints, layers.droneWaypoints);
  useGeoJsonOverlay(handle, "vg-drone-tracks", drones.tracks, layers.droneTracks);

  const recenter = () => {
    if (frameBounds) controller.fit(frameBounds, { maxZoom: FRAME_MAX_ZOOM, animate: true });
  };
  const recenterFromEffect = useEffectEvent(recenter);

  // Si la ubicación del incidente se corrige mucho (no en cada sondeo), se vuelve a encuadrar.
  const framedOriginRef = useRef(origin);
  useEffect(() => {
    const prev = framedOriginRef.current;
    framedOriginRef.current = origin;
    const moved = !isValidLatLng(prev.lat, prev.lng) || distanceM(prev, origin) > REFRAME_ON_MOVE_M;
    if (map && originOk && moved) recenterFromEffect();
  }, [map, origin, originOk]);

  const local = (x: number, y: number) => toLatLng(origin, { x, y });
  const s = drawableScene;
  const TypeIcon = INCIDENT_TYPE_ICON[incident.type];
  const incidentLabel = [
    `${INCIDENT_TYPE_LABEL[incident.type]}: ${incident.title}`,
    incident.address,
    atRisk ? "Personas en riesgo según la reconstrucción de la escena" : "",
    "Activar para acercar",
  ]
    .filter(Boolean)
    .join(". ");

  const legend = useMemo<LegendItem[]>(() => {
    const items: LegendItem[] = [
      { key: "incident", label: "Incidente", tone: atRisk ? "critical" : "accent", swatch: "dot" },
      { key: "rings", label: `Anillos ${RANGE_RINGS_M.join(" / ")} m`, tone: "neutral", swatch: "dashed" },
    ];
    if (s) {
      if (s.people.some((p) => isPersonAtRisk(p.status)))
        items.push({ key: "p-risk", label: "Personas en riesgo", tone: "critical", swatch: "dot" });
      if (s.people.some((p) => !isPersonAtRisk(p.status)))
        items.push({ key: "p-other", label: "Otras personas", tone: "warning", swatch: "dot" });
      for (const role of ["involved", "exposure", "reference"] as const) {
        if (s.structures.some((x) => x.role === role))
          items.push({
            key: `st-${role}`,
            label: STRUCTURE_ROLE_LABEL[role],
            tone: role === "involved" ? "accent" : role === "exposure" ? "warning" : "neutral",
            swatch: "fill",
          });
      }
      if (s.structures.length) items.push({ key: "facade", label: "Fachada principal", tone: "neutral", swatch: "line" });
      if (s.fire_zones.length) items.push({ key: "fire", label: "Foco de fuego", tone: "accent", swatch: "fill" });
      if (s.hazards.length) items.push({ key: "hazard", label: "Zona de peligro", tone: "warning", swatch: "dashed" });
      if (s.vehicles.length) items.push({ key: "vehicle", label: "Vehículo involucrado", tone: "neutral", swatch: "fill" });
      if (s.roads.some((r) => r.blocked)) items.push({ key: "blocked", label: "Vía bloqueada", tone: "critical", swatch: "dashed" });
      for (const kind of ["hydrant", "command_post", "staging"] as const) {
        if (s.access_points.some((a) => a.kind === kind))
          items.push({ key: `ap-${kind}`, label: ACCESS_KIND_LABEL[kind], tone: accessTone(kind), swatch: "icon", icon: ACCESS_ICON[kind] });
      }
      if (s.access_points.some((a) => accessTone(a.kind) === "neutral"))
        items.push({ key: "ap-other", label: "Accesos", tone: "neutral", swatch: "icon", icon: ACCESS_ICON.door });
    }
    if (cameras.length) items.push({ key: "cam", label: "Cámara M‹n› y su campo de visión", tone: "info", swatch: "cone" });
    if (cameras.some((c) => c.estimatedPosition || c.estimatedHeading))
      items.push({ key: "cam-est", label: "Cámara estimada por IA", tone: "info", swatch: "dashed" });
    if (missions.length) {
      items.push({ key: "drone", label: "Dron: traza recorrida", tone: "drone", swatch: "line" });
      items.push({ key: "drone-route", label: "Dron: ruta planificada", tone: "drone", swatch: "dashed" });
    }
    return items;
  }, [s, cameras, missions.length, atRisk]);

  const legendFooter = s
    ? `Escena reconstruida por IA, confianza ${CONFIDENCE_LABEL[s.confidence]}. Posiciones aproximadas.`
    : "Aún no hay reconstrucción de la escena.";

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="absolute inset-0" />

      {originOk &&
        RANGE_RINGS_M.map((r) => (
          <MapMarker key={`ring-${r}`} map={map} position={destination(origin, 0, r)} anchor="bottom" zIndex={0}>
            <RingLabel>{r} m</RingLabel>
          </MapMarker>
        ))}

      {s?.access_points
        .filter((a) => isLocalOk(a.x, a.y))
        .map((a) => (
          <MapMarker key={`ap-${a.id}`} map={map} position={local(a.x, a.y)} zIndex={5}>
            <InfoMarker
              icon={ACCESS_ICON[a.kind]}
              tone={accessTone(a.kind)}
              shape="square"
              size="sm"
              tip={{ title: a.label ? `${ACCESS_KIND_LABEL[a.kind]}: ${a.label}` : ACCESS_KIND_LABEL[a.kind], lines: [a.note] }}
            />
          </MapMarker>
        ))}

      {s?.vehicles
        .filter((v) => isLocalOk(v.x, v.y))
        .map((v) => {
          const tone = vehicleTone(v);
          return (
            <MapMarker key={`veh-${v.id}`} map={map} position={local(v.x, v.y)} zIndex={tone === "critical" ? 25 : 8}>
              <InfoMarker
                icon={VEHICLE_ICON[v.kind]}
                tone={tone}
                size="sm"
                tip={{
                  title: `${VEHICLE_KIND_LABEL[v.kind]} ${VEHICLE_STATE_LABEL[v.state]}`,
                  lines: [
                    v.entrapment_suspected ? "Posible persona atrapada en el vehículo" : "",
                    v.burning ? "En llamas" : "",
                    v.note,
                  ],
                }}
              />
            </MapMarker>
          );
        })}

      {s?.fire_zones
        .filter((f) => isLocalOk(f.x, f.y))
        .map((f) => (
          <MapMarker key={`fire-${f.id}`} map={map} position={local(f.x, f.y)} zIndex={10}>
            <InfoMarker
              icon={Flame}
              tone={f.intensity === "smoke_only" ? "neutral" : "accent"}
              size="sm"
              tip={{
                title: FIRE_INTENSITY_LABEL[f.intensity],
                lines: [
                  [floorText(f.floor), STRUCTURE_SIDE_LABEL[f.side]].filter(Boolean).join(", "),
                  f.note,
                  aiConfidence(f.confidence),
                ],
              }}
            />
          </MapMarker>
        ))}

      {s?.hazards
        .filter((h) => isLocalOk(h.x, h.y))
        .map((h) => (
          <MapMarker key={`hz-${h.id}`} map={map} position={local(h.x, h.y)} zIndex={h.severity === "high" ? 22 : 12}>
            <InfoMarker
              icon={HAZARD_ICON[h.kind]}
              tone={h.severity === "high" ? "critical" : "warning"}
              tip={{
                title: `Peligro: ${HAZARD_KIND_LABEL[h.kind]}`,
                lines: [
                  `Severidad ${HAZARD_SEVERITY_LABEL[h.severity]}`,
                  h.radius_m > 0 ? `Zona sugerida de ${formatMeters(h.radius_m)} de radio` : "",
                  h.note,
                ],
              }}
            />
          </MapMarker>
        ))}

      {cameras.map((c) => (
        <MapMarker key={`cam-${c.mediaId}`} map={map} position={c.position} zIndex={15}>
          <CameraMarker
            label={c.label}
            kind={c.kind}
            drone={c.source === "drone"}
            estimated={c.estimatedPosition || c.estimatedHeading}
            tip={cameraTip(c)}
            onOpen={onOpenMedia ? () => onOpenMedia(c.label) : undefined}
          />
        </MapMarker>
      ))}

      {missions
        .filter((m) => isValidLatLng(m.home_lat, m.home_lng))
        .map((m) => (
        <MapMarker
          key={`home-${m.id}`}
          map={map}
          position={{ lat: m.home_lat, lng: m.home_lng }}
          zIndex={6}
        >
          <InfoMarker
            icon={PlaneTakeoff}
            tone="drone"
            shape="square"
            size="sm"
            tip={{ title: `Despegue de ${m.label}`, lines: [] }}
          />
        </MapMarker>
      ))}

      {missions.map((m) => {
          const last = m.last;
          if (!last || !isValidLatLng(last.lat, last.lng)) return null;
          const heading = validHeading(last.heading_deg) ?? 0;
          return (
            <MapMarker key={`drone-${m.id}`} map={map} position={last} zIndex={30}>
              <DroneMarker
                label={m.label}
                headingDeg={heading}
                altitudeM={Number.isFinite(last.alt_m) ? last.alt_m : null}
                active={isMissionActive(m.status)}
                tip={{
                  title: `Dron ${m.label}`,
                  lines: [
                    MISSION_STATUS_LABEL[m.status],
                    `Altura ${Math.round(last.alt_m)} m, rumbo ${formatBearing(heading)}`,
                    last.battery_pct !== null ? `Batería ${Math.round(last.battery_pct)} %` : "",
                    originOk ? `A ${formatMeters(distanceM(origin, last))} del incidente` : "",
                  ],
                }}
              />
            </MapMarker>
          );
        })}

      {originOk && (
        <MapMarker map={map} position={origin} zIndex={35}>
          <IncidentMarker
            icon={TypeIcon}
            label={incidentLabel}
            atRisk={atRisk}
            onActivate={() => controller.flyTo(origin, Math.max(map?.getZoom() ?? 0, FRAME_MAX_ZOOM))}
          />
        </MapMarker>
      )}

      {s?.people
        .filter((p) => isLocalOk(p.x, p.y))
        .map((p) => {
          const tone = personTone(p.status);
          return (
            <MapMarker key={`person-${p.id}`} map={map} position={local(p.x, p.y)} zIndex={tone === "critical" ? 45 : 20}>
              <InfoMarker
                icon={p.count > 1 ? Users : User}
                tone={tone}
                badge={p.count > 1 ? String(Math.round(p.count)) : undefined}
                tip={{
                  title: personGroupLabel(p.status, p.count),
                  lines: [floorText(p.floor), p.note, aiConfidence(p.confidence)],
                }}
              />
            </MapMarker>
          );
        })}

      <LoadingVeil show={!error && !loaded} />
      {error && <MapFatalError message={error} detail={originOk ? `Ubicación del incidente: ${formatLatLng(origin)}` : undefined} />}

      {!error && (
        <>
          <div className="pointer-events-none absolute right-2 top-2 flex flex-col items-end gap-1.5">
            <MapButton label="Centrar" showLabel disabled={!map || !originOk} onClick={recenter}>
              <LocateFixed className="size-4" aria-hidden />
            </MapButton>
            <ZoomControls map={map} />
          </div>
          <div className="pointer-events-none absolute left-2 top-2">
            <MapLegend items={legend} footer={legendFooter} />
          </div>
          <div className="pointer-events-none absolute bottom-2 left-2 flex flex-col items-start gap-1">
            {!originOk && (
              <span role="status" className="rounded-control border border-warning bg-surface/90 px-2 py-1 text-xs text-warning">
                El incidente no tiene una ubicación válida.
              </span>
            )}
            <BaseMapNotice base={base} />
          </div>
        </>
      )}
    </div>
  );
}
