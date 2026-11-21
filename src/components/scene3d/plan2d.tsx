"use client";
/**
 * Planta 2D en SVG: vista cenital del mismo modelo con la misma simbología.
 * Es el respaldo sin WebGL y la vista por defecto en modo compacto.
 * Funciona en el servidor (SSR) y de 320 px a pantalla completa.
 */
import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Flame, LocateFixed, ZoomIn, ZoomOut } from "lucide-react";
import { headingVector } from "@/lib/geo";
import { clamp, footprintCorners, groundSize, localToWorld, niceScaleLength, type XY } from "./geometry";
import {
  footprintOf,
  type NAccess,
  type NCamera,
  type NDrone,
  type NFire,
  type NHazard,
  type NPerson,
  type NRoad,
  type NSmoke,
  type NStructure,
  type NVehicle,
  type SceneView,
} from "./model";
import { DEFAULT_LAYERS, type LayerState } from "./layers";
import type { Scene3DProps, SceneEntityKind, SceneSelection } from "./types";
import {
  ACCESS_KIND_LABEL,
  CONFIDENCE_LABEL,
  HAZARD_KIND_LABEL,
  droneCaption,
  fireCaption,
  personCaption,
  structureCaption,
  structureTitle,
  vehicleCaption,
} from "./labels";
import { ACCESS_ICON, ACCESS_TONE, HAZARD_ICON, HAZARD_TONE, type Tone } from "./icons";
import { TONE_FILL, TONE_STROKE, TONE_TEXT, cx } from "./tones";
import { SMOKE_HEX } from "./palette";
import { useElementSize, useSceneView, useSelection } from "./hooks";
import { coreBounds, declutter } from "./three/pose";
import { buildingPath, type Surroundings } from "./surroundings";
import { useSceneSurroundings } from "./surroundings-data";
import { SceneEmpty, SceneFrame } from "./frame";

/** Redondeo a centímetros (markup más liviano y estable). */
const r2 = (v: number) => Math.round(v * 100) / 100 + 0;
/** ENU → SVG (y hacia abajo = Sur). */
const sv = (p: XY) => `${r2(p.x)},${r2(-p.y)}`;

const ROLE_CLASS: Record<NStructure["role"], { fill: string; stroke: string; facade: string; text: string }> = {
  involved: { fill: "fill-fire/15", stroke: "stroke-fire", facade: "stroke-fire", text: "fill-fire" },
  exposure: { fill: "fill-warning/10", stroke: "stroke-warning/70", facade: "stroke-warning", text: "fill-warning" },
  reference: { fill: "fill-muted/10", stroke: "stroke-line-strong", facade: "stroke-muted", text: "fill-muted" },
};

const SMOKE_LENGTH: Record<NSmoke["volume"], number> = { light: 12, moderate: 20, heavy: 30 };

interface Ctx {
  /** Metros por píxel de pantalla. */
  k: number;
  labels: boolean;
  isSelected: (kind: SceneEntityKind, id: string) => boolean;
  pick: (kind: SceneEntityKind, id: string, ariaLabel: string, after?: () => void) => PickAttrs;
}

interface PickAttrs {
  role: "button";
  tabIndex: number;
  "aria-label": string;
  "aria-pressed": boolean;
  className: string;
  onClick: (e: ReactMouseEvent) => void;
  onKeyDown: (e: KeyboardEvent) => void;
}

/** Texto con halo del color de fondo para que se lea sobre cualquier cosa. */
function Halo({
  x,
  y,
  k,
  size = 11,
  className,
  anchor = "start",
  weight,
  lines,
  priority,
  pinned = false,
}: {
  x: number;
  y: number;
  k: number;
  size?: number;
  className: string;
  anchor?: "start" | "middle" | "end";
  weight?: number;
  lines: string[];
  /** Prioridad para el despeje de etiquetas superpuestas (mayor = gana). */
  priority: number;
  /** Nunca se oculta. */
  pinned?: boolean;
}) {
  return (
    <text
      data-vg-label=""
      data-p={priority}
      data-pin={pinned ? "1" : undefined}
      x={x}
      y={y}
      fontSize={size * k}
      textAnchor={anchor}
      fontWeight={weight}
      className={cx("stroke-bg font-sans", className)}
      strokeWidth={3 * k}
      strokeLinejoin="round"
      style={{ paintOrder: "stroke" }}
      pointerEvents="none"
    >
      {lines.map((l, i) => (
        <tspan key={i} x={x} dy={i === 0 ? 0 : size * 1.2 * k}>
          {l}
        </tspan>
      ))}
    </text>
  );
}

function SelRing({ r, k }: { r: number; k: number }) {
  return <circle r={r + 5 * k} className="fill-none stroke-info" strokeWidth={2 * k} />;
}

/* ───────────────────────────── Entidades ───────────────────────────── */

function RoadShape({ road, k, labels, hatchId, ctx }: { road: NRoad; k: number; labels: boolean; hatchId: string; ctx: Ctx }) {
  const angle = (Math.atan2(-(road.y2 - road.y1), road.x2 - road.x1) * 180) / Math.PI;
  const readable = angle > 90 || angle < -90 ? angle + 180 : angle;
  const mx = (road.x1 + road.x2) / 2;
  const my = -(road.y1 + road.y2) / 2;
  const name = road.name || (road.blocked ? "Vía" : "");
  const selected = ctx.isSelected("road", road.id);
  return (
    <g {...ctx.pick("road", road.id, `Calle${road.name ? ` ${road.name}` : ""}${road.blocked ? ", bloqueada" : ""}`)}>
      <line
        x1={road.x1}
        y1={-road.y1}
        x2={road.x2}
        y2={-road.y2}
        strokeWidth={road.width + 0.8}
        className={selected ? "stroke-info" : "stroke-line-strong"}
        strokeLinecap="butt"
      />
      <line x1={road.x1} y1={-road.y1} x2={road.x2} y2={-road.y2} strokeWidth={road.width} className="stroke-surface-2" />
      {road.blocked && (
        <line x1={road.x1} y1={-road.y1} x2={road.x2} y2={-road.y2} strokeWidth={road.width} stroke={`url(#${hatchId})`} />
      )}
      {(labels || road.blocked) && name && (
        <g transform={`translate(${mx} ${my}) rotate(${-readable})`}>
          <Halo
            x={0}
            y={3.5 * k}
            k={k}
            size={10}
            anchor="middle"
            className={road.blocked ? "fill-warning" : "fill-muted"}
            weight={road.blocked ? 600 : 500}
            priority={road.blocked ? 58 : 24}
            pinned={selected}
            lines={[road.blocked ? `${name} · bloqueada` : name]}
          />
        </g>
      )}
    </g>
  );
}

function StructureShape({ s, ctx }: { s: NStructure; ctx: Ctx }) {
  const { k } = ctx;
  const fp = footprintOf(s);
  const corners = footprintCorners(fp);
  const cls = ROLE_CLASS[s.role];
  const selected = ctx.isSelected("structure", s.id);
  const arrowLen = Math.max(1.6, 10 * k);
  const arrowHalf = Math.max(1, 6 * k);
  const tip = localToWorld(fp, 0, s.depth / 2 + 0.3 + arrowLen);
  const bl = localToWorld(fp, -arrowHalf, s.depth / 2 + 0.3);
  const br = localToWorld(fp, arrowHalf, s.depth / 2 + 0.3);
  const aLabel = localToWorld(fp, 0, s.depth / 2 + 0.3 + arrowLen + 8 * k);
  const ridgeA = localToWorld(fp, -s.width / 2, 0);
  const ridgeB = localToWorld(fp, s.width / 2, 0);
  const title = structureTitle(s);
  return (
    <g {...ctx.pick("structure", s.id, `Estructura: ${title}, ${structureCaption(s)}`)}>
      <polygon
        points={corners.map(sv).join(" ")}
        className={cx(cls.fill, selected ? "stroke-info" : cls.stroke)}
        strokeWidth={selected ? 3 : 1.5}
        vectorEffect="non-scaling-stroke"
        strokeDasharray={s.confidence === "low" ? "6 4" : undefined}
      />
      {s.roof === "gable" && (
        <line
          x1={ridgeA.x}
          y1={-ridgeA.y}
          x2={ridgeB.x}
          y2={-ridgeB.y}
          className={cls.stroke}
          strokeWidth={1}
          strokeDasharray="4 3"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {/* Fachada principal */}
      <line
        x1={corners[0].x}
        y1={-corners[0].y}
        x2={corners[1].x}
        y2={-corners[1].y}
        className={cls.facade}
        strokeWidth={4}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      <polygon points={[bl, tip, br].map(sv).join(" ")} className={cx(TONE_FILL.text, "opacity-80")} />
      <Halo x={aLabel.x} y={-aLabel.y + 3.5 * k} k={k} size={9} anchor="middle" className="fill-muted" weight={600} lines={["A"]} priority={12} />
      {ctx.labels && (
        <Halo
          x={s.x}
          y={-s.y}
          k={k}
          anchor="middle"
          className="fill-text"
          weight={600}
          lines={[title, structureCaption(s)]}
          priority={s.role === "involved" ? 68 : s.role === "exposure" ? 50 : 38}
          pinned={selected}
        />
      )}
    </g>
  );
}

function FireShape({ f, fireGradId, ctx }: { f: NFire; fireGradId: string; ctx: Ctx }) {
  const { k } = ctx;
  const selected = ctx.isSelected("fire", f.id);
  const r = Math.max(f.radius, 5 * k);
  const icon = 13 * k;
  return (
    <g {...ctx.pick("fire", f.id, fireCaption(f))} transform={`translate(${f.x} ${-f.y})`}>
      {f.intensity === "smoke_only" ? (
        <circle
          r={r * 1.3}
          className="fill-muted/25 stroke-muted"
          strokeDasharray="3 3"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      ) : (
        <>
          <circle r={r} fill={`url(#${fireGradId})`} className="motion-safe:animate-pulse" />
          <Flame
            x={-icon / 2}
            y={-icon / 2}
            size={icon}
            className={f.intensity === "heavy" ? "text-critical" : "text-warning"}
            strokeWidth={2.4}
          />
        </>
      )}
      {selected && <SelRing r={r} k={k} />}
      {ctx.labels && (
        <Halo x={r + 4 * k} y={-r * 0.4} k={k} size={10} className="fill-fire" weight={600} lines={[fireCaption(f)]} priority={f.intensity === "heavy" ? 72 : f.intensity === "smoke_only" ? 48 : 62} pinned={selected} />
      )}
    </g>
  );
}

function SmokeShape({ s, ctx }: { s: NSmoke; ctx: Ctx }) {
  const color = SMOKE_HEX[s.color];
  const selected = ctx.isSelected("smoke", s.id);
  const L = SMOKE_LENGTH[s.volume];
  let shape: ReactNode;
  if (s.driftDeg === null) {
    shape = <circle cx={s.x} cy={-s.y} r={L * 0.3} fill={color} fillOpacity={0.3} />;
  } else {
    const d = headingVector(s.driftDeg);
    const p = headingVector(s.driftDeg + 90);
    const at = (a: number, b: number): XY => ({ x: s.x + d.x * a + p.x * b, y: s.y + d.y * a + p.y * b });
    const pts = [at(0, 1.5), at(L * 0.55, L * 0.28), at(L, L * 0.32), at(L * 1.12, 0), at(L, -L * 0.32), at(L * 0.55, -L * 0.28), at(0, -1.5)];
    shape = <polygon points={pts.map(sv).join(" ")} fill={color} fillOpacity={0.32} strokeLinejoin="round" />;
  }
  return (
    <g {...ctx.pick("smoke", s.id, "Columna de humo")}>
      {shape}
      {selected && (
        <circle cx={s.x} cy={-s.y} r={6 * ctx.k} className="fill-none stroke-info" strokeWidth={2 * ctx.k} />
      )}
    </g>
  );
}

function VehicleShape({ v, ctx }: { v: NVehicle; ctx: Ctx }) {
  const { k } = ctx;
  const fp = { x: v.x, y: v.y, width: v.width, depth: v.length, rotationDeg: v.rotationDeg };
  const c = footprintCorners(fp);
  const selected = ctx.isSelected("vehicle", v.id);
  const tipped = v.state === "on_side" || v.state === "overturned";
  const halo = Math.max(v.length, v.width) * 0.8;
  const caption = vehicleCaption(v);
  return (
    <g {...ctx.pick("vehicle", v.id, `Vehículo: ${caption}${v.entrapment ? ", posible atrapamiento" : ""}`)}>
      {v.entrapment && (
        <circle
          cx={v.x}
          cy={-v.y}
          r={halo}
          className="fill-critical/10 stroke-critical"
          strokeWidth={2}
          strokeDasharray="5 3"
          vectorEffect="non-scaling-stroke"
        />
      )}
      <polygon
        points={c.map(sv).join(" ")}
        className={cx(v.burning ? "fill-fire/40 stroke-fire" : "fill-line-strong/70 stroke-muted", selected && "stroke-info")}
        strokeWidth={selected ? 2.5 : 1.2}
        strokeDasharray={tipped ? "3 2" : undefined}
        vectorEffect="non-scaling-stroke"
      />
      <line x1={c[0].x} y1={-c[0].y} x2={c[1].x} y2={-c[1].y} className="stroke-text" strokeWidth={2.2} vectorEffect="non-scaling-stroke" />
      {v.burning && <Flame x={v.x - 6 * k} y={-v.y - 6 * k} size={12 * k} className="text-warning" strokeWidth={2.4} />}
      {(ctx.labels || v.entrapment) && (
        <Halo
          x={v.x + halo * (v.entrapment ? 1 : 0.6) + 3 * k}
          y={-v.y}
          k={k}
          size={10}
          className={v.entrapment ? "fill-critical" : "fill-text"}
          weight={v.entrapment ? 700 : 500}
          lines={v.entrapment ? [caption, "Posible atrapamiento"] : [caption]}
          priority={v.entrapment ? 95 : v.burning ? 52 : 40}
          pinned={v.entrapment || selected}
        />
      )}
    </g>
  );
}

function HazardShape({ h, ctx }: { h: NHazard; ctx: Ctx }) {
  const { k } = ctx;
  const tone = HAZARD_TONE[h.severity];
  const Icon = HAZARD_ICON[h.kind];
  const selected = ctx.isSelected("hazard", h.id);
  const zone: Record<NHazard["severity"], string> = {
    low: "fill-info/10 stroke-info/60",
    medium: "fill-warning/10 stroke-warning/70",
    high: "fill-critical/10 stroke-critical/70",
  };
  return (
    <g {...ctx.pick("hazard", h.id, `Peligro: ${HAZARD_KIND_LABEL[h.kind]}`)}>
      <circle cx={h.x} cy={-h.y} r={h.radius} className={zone[h.severity]} strokeDasharray="6 4" strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
      <g transform={`translate(${h.x} ${-h.y})`}>
        <circle r={9 * k} className={cx("fill-surface", TONE_STROKE[tone])} strokeWidth={1.5 * k} />
        <Icon x={-6 * k} y={-6 * k} size={12 * k} className={TONE_TEXT[tone]} strokeWidth={2.2} />
        {selected && <SelRing r={9 * k} k={k} />}
        {ctx.labels && (
          <Halo x={12 * k} y={4 * k} k={k} size={10} className={TONE_FILL[tone]} weight={600} lines={[HAZARD_KIND_LABEL[h.kind]]} priority={h.severity === "high" ? 70 : h.severity === "medium" ? 56 : 44} pinned={selected} />
        )}
      </g>
    </g>
  );
}

function AccessShape({ a, ctx }: { a: NAccess; ctx: Ctx }) {
  const { k } = ctx;
  const tone: Tone = ACCESS_TONE[a.kind];
  const Icon = ACCESS_ICON[a.kind];
  const selected = ctx.isSelected("access", a.id);
  const text = a.label || ACCESS_KIND_LABEL[a.kind];
  return (
    <g {...ctx.pick("access", a.id, `${ACCESS_KIND_LABEL[a.kind]}${a.label ? `: ${a.label}` : ""}`)} transform={`translate(${a.x} ${-a.y})`}>
      <rect
        x={-8 * k}
        y={-8 * k}
        width={16 * k}
        height={16 * k}
        rx={3 * k}
        className={cx("fill-surface", TONE_STROKE[tone])}
        strokeWidth={1.5 * k}
      />
      <Icon x={-5.5 * k} y={-5.5 * k} size={11 * k} className={TONE_TEXT[tone]} strokeWidth={2.2} />
      {selected && <SelRing r={9 * k} k={k} />}
      {ctx.labels && (
        <Halo
          x={11 * k}
          y={4 * k}
          k={k}
          size={10}
          className={TONE_FILL[tone]}
          weight={500}
          lines={[text]}
          priority={a.kind === "command_post" ? 46 : a.kind === "hydrant" ? 45 : 34}
          pinned={selected}
        />
      )}
    </g>
  );
}

function CameraShape({ c, ctx, onOpen }: { c: NCamera; ctx: Ctx; onOpen?: (label: string) => void }) {
  const { k } = ctx;
  const selected = ctx.isSelected("camera", c.mediaRef);
  const L = Math.max(8, 36 * k);
  let wedge: ReactNode = null;
  if (c.facingDeg !== null) {
    const a = headingVector(c.facingDeg - 28);
    const b = headingVector(c.facingDeg + 28);
    const pts = [{ x: c.x, y: c.y }, { x: c.x + a.x * L, y: c.y + a.y * L }, { x: c.x + b.x * L, y: c.y + b.y * L }];
    wedge = (
      <polygon
        points={pts.map(sv).join(" ")}
        className={cx("fill-info/15", selected ? "stroke-info" : "stroke-info/60")}
        strokeWidth={selected ? 2 : 1}
        vectorEffect="non-scaling-stroke"
      />
    );
  }
  const w = (c.mediaRef.length * 6.6 + 8) * k;
  const h = 14 * k;
  return (
    <g
      {...ctx.pick("camera", c.mediaRef, `Cámara del medio ${c.mediaRef}${onOpen ? ". Abrir medio" : ""}`, () =>
        onOpen?.(c.mediaRef),
      )}
    >
      {wedge}
      <g transform={`translate(${c.x} ${-c.y})`}>
        <rect
          x={-w / 2}
          y={-h / 2}
          width={w}
          height={h}
          rx={3 * k}
          className={cx(selected ? "fill-text" : "fill-info", "stroke-bg")}
          strokeWidth={1.2 * k}
        />
        <text
          y={3.6 * k}
          textAnchor="middle"
          fontSize={10 * k}
          fontWeight={700}
          className="fill-bg font-mono"
          pointerEvents="none"
        >
          {c.mediaRef}
        </text>
      </g>
    </g>
  );
}

function DroneShape({ d, ctx }: { d: NDrone; ctx: Ctx }) {
  const { k } = ctx;
  const selected = ctx.isSelected("drone", d.id);
  const s = 7 * k;
  return (
    <g {...ctx.pick("drone", d.id, `Dron ${droneCaption(d)}`)}>
      {d.track.length > 1 && (
        <polyline
          points={d.track.map(sv).join(" ")}
          className="fill-none stroke-drone/70"
          strokeWidth={1.5}
          strokeDasharray="5 4"
          vectorEffect="non-scaling-stroke"
        />
      )}
      <g transform={`translate(${d.x} ${-d.y}) rotate(${d.headingDeg})`}>
        <path
          d={`M0,${-s} L${s * 0.75},${s * 0.8} L0,${s * 0.4} L${-s * 0.75},${s * 0.8} Z`}
          className={cx(d.active ? "fill-drone" : "fill-muted", "stroke-bg")}
          strokeWidth={1.2 * k}
        />
      </g>
      {selected && (
        <circle cx={d.x} cy={-d.y} r={s + 5 * k} className="fill-none stroke-info" strokeWidth={2 * k} />
      )}
      <Halo x={d.x + s + 4 * k} y={-d.y + 3.5 * k} k={k} size={10} className="fill-drone" weight={600} lines={[droneCaption(d)]} priority={60} pinned={selected} />
    </g>
  );
}

function PersonShape({ p, ctx }: { p: NPerson; ctx: Ctx }) {
  const { k } = ctx;
  const selected = ctx.isSelected("person", p.id);
  const critical = p.risk === "critical";
  const r = (critical ? 7 : p.risk === "injured" ? 6 : 4.5) * k;
  const fill = critical ? "fill-critical" : p.risk === "injured" ? "fill-warning" : "fill-muted";
  const caption = personCaption(p);
  const showCount = (critical || p.risk === "injured") && p.count >= 1 && p.count <= 99;
  return (
    <g {...ctx.pick("person", p.id, `${caption}, confianza ${CONFIDENCE_LABEL[p.confidence]}`)} transform={`translate(${p.x} ${-p.y})`}>
      {critical && (
        <circle
          r={r * 1.7}
          className="fill-none stroke-critical motion-safe:animate-ping"
          strokeWidth={1.6 * k}
          style={{ transformBox: "fill-box", transformOrigin: "center" }}
        />
      )}
      <circle r={r} className={cx(fill, "stroke-bg")} strokeWidth={1.5 * k} />
      {showCount && (
        <text y={3 * k} textAnchor="middle" fontSize={8.5 * k} fontWeight={700} className="fill-bg font-mono" pointerEvents="none">
          {p.count}
        </text>
      )}
      {selected && <SelRing r={r} k={k} />}
      {(critical || ctx.labels) && (
        <Halo
          x={r + 4 * k}
          y={3.5 * k}
          k={k}
          size={critical ? 11.5 : 10}
          className={critical ? "fill-critical" : p.risk === "injured" ? "fill-warning" : "fill-muted"}
          weight={critical ? 700 : 500}
          lines={critical ? [caption, `confianza ${CONFIDENCE_LABEL[p.confidence]}`] : [caption]}
          priority={critical ? 100 : p.risk === "injured" ? 62 : 36}
          pinned={critical || selected}
        />
      )}
    </g>
  );
}

/* ───────────────────────────── Planta ───────────────────────────── */

export interface PlanSvgProps {
  view: SceneView;
  layers: LayerState;
  selection: SceneSelection | null;
  onSelect: (sel: SceneSelection | null) => void;
  onOpenMedia?: (mediaLabel: string, frame?: number) => void;
  className?: string;
  /** Entorno real (OSM): contornos tenues bajo la escena, sin interacción. */
  surroundings?: Surroundings;
}

const DEFAULT_SIZE = { width: 640, height: 420 };

export function PlanSvg({ view, layers, selection, onSelect, onOpenMedia, className, surroundings }: PlanSvgProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const size = useElementSize(hostRef, DEFAULT_SIZE);
  // null = encuadre automático (núcleo táctico); el usuario lo cambia con zoom o arrastre.
  const [user, setUser] = useState<{ zoom: number; pan: XY } | null>(null);
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean; pan0: XY } | null>(null);
  const suppressClick = useRef(false);
  const rawId = useId();
  const uid = rawId.replace(/[^a-zA-Z0-9_-]/g, "");
  const gridId = `vg-grid-${uid}`;
  const hatchId = `vg-hatch-${uid}`;
  const fireGradId = `vg-fire-${uid}`;

  const s = view.scene;
  const f = view.frame;
  const aspect = size.width / Math.max(1, size.height);
  let w = f.maxX - f.minX;
  let h = f.maxY - f.minY;
  if (w / h < aspect) w = h * aspect;
  else h = w / aspect;
  // Primer encuadre: el núcleo (estructura afectada, focos, víctimas) con algo de contexto.
  const core = useMemo(() => coreBounds(view.scene, view.frame), [view.scene, view.frame]);
  const coreW = Math.max(core.maxX - core.minX, (core.maxY - core.minY) * aspect) * 1.3;
  const autoZoom = clamp(w / Math.max(1, coreW), 1, 6);
  const autoPan = { x: (core.minX + core.maxX) / 2 - (f.minX + f.maxX) / 2, y: (core.minY + core.maxY) / 2 - (f.minY + f.maxY) / 2 };
  const zoom = user?.zoom ?? autoZoom;
  const pan = user?.pan ?? (autoZoom > 1 ? autoPan : { x: 0, y: 0 });
  w /= zoom;
  h /= zoom;
  const cx0 = (f.minX + f.maxX) / 2 + pan.x;
  const cy0 = (f.minY + f.maxY) / 2 + pan.y;
  const k = w / Math.max(1, size.width);
  const viewBox = `${cx0 - w / 2} ${-(cy0 + h / 2)} ${w} ${h}`;

  const gSize = groundSize(view.extent, s.focus);
  const gx = Math.round(s.focus.x / 10) * 10;
  const gy = Math.round(s.focus.y / 10) * 10;

  const isSelected = (kind: SceneEntityKind, id: string) => selection?.kind === kind && selection.id === id;
  const pick = (kind: SceneEntityKind, id: string, ariaLabel: string, after?: () => void): PickAttrs => {
    const activate = () => {
      onSelect({ kind, id });
      after?.();
    };
    return {
      role: "button",
      tabIndex: 0,
      "aria-label": ariaLabel,
      "aria-pressed": isSelected(kind, id),
      className: "cursor-pointer",
      onClick: (e) => {
        e.stopPropagation();
        if (suppressClick.current) {
          suppressClick.current = false;
          return;
        }
        activate();
      },
      onKeyDown: (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activate();
        }
      },
    };
  };
  const ctx: Ctx = { k, labels: layers.labels, isSelected, pick };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, pan0: pan };
    suppressClick.current = false;
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 4) return;
      d.moved = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    setUser({ zoom, pan: { x: d.pan0.x - dx * k, y: d.pan0.y + dy * k } });
  };
  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (d.moved) suppressClick.current = true;
  };
  const onBackgroundClick = () => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    onSelect(null);
  };

  const zoomBy = (factor: number) => setUser({ zoom: clamp(zoom * factor, 1, 10), pan });
  const reset = () => setUser(null);

  // Despeje: si dos rótulos se tapan, se oculta el de menor prioridad (las personas en riesgo nunca).
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const els = Array.from(svg.querySelectorAll<SVGTextElement>("[data-vg-label]"));
    const boxes = els.map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height, priority: Number(el.dataset.p) || 0, pinned: el.dataset.pin === "1" };
    });
    const placement = declutter(boxes, { shift: false });
    els.forEach((el, i) => {
      const v = placement[i].visible ? "" : "hidden";
      if (el.style.visibility !== v) el.style.visibility = v;
    });
  });

  const envPath = useMemo(() => (surroundings?.buildings ?? []).map(buildingPath).join(""), [surroundings]);
  const envRoads = useMemo(() => {
    const g = surroundings?.roadSegments ?? [];
    let d = "";
    for (let i = 0; i + 3 < g.length; i += 4) d += `M${r2(g[i])} ${r2(-g[i + 1])}L${r2(g[i + 2])} ${r2(-g[i + 3])}`;
    return d;
  }, [surroundings]);

  const scaleLen = niceScaleLength(k, 80);
  const scalePx = scaleLen / k;
  const focus = s.focus;

  return (
    <div ref={hostRef} className={cx("relative h-full min-h-[220px] w-full overflow-hidden bg-bg select-none", className)}>
      <svg
        ref={svgRef}
        viewBox={viewBox}
        width="100%"
        height="100%"
        className="absolute inset-0 block h-full w-full"
        style={{ touchAction: user && zoom > 1 ? "none" : "manipulation" }}
        role="group"
        aria-label="Planta de la reconstrucción, vista cenital con el Norte hacia arriba"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={onBackgroundClick}
      >
        <defs>
          <pattern id={gridId} width={10} height={10} patternUnits="userSpaceOnUse">
            <path d="M10 0H0V10" className="fill-none stroke-line" strokeWidth={k} />
          </pattern>
          <pattern id={hatchId} width={2.4} height={2.4} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width={1.1} height={2.4} className="fill-warning/70" />
          </pattern>
          <radialGradient id={fireGradId}>
            <stop offset="0%" stopColor="currentColor" stopOpacity={0.95} className="text-warning" />
            <stop offset="55%" stopColor="currentColor" stopOpacity={0.7} className="text-fire" />
            <stop offset="100%" stopColor="currentColor" stopOpacity={0} className="text-critical" />
          </radialGradient>
        </defs>

        {/* Suelo: grilla de 10 m y anillos de 25/50 m */}
        <rect x={gx - gSize / 2} y={-(gy + gSize / 2)} width={gSize} height={gSize} className="fill-surface" />
        <rect x={gx - gSize / 2} y={-(gy + gSize / 2)} width={gSize} height={gSize} fill={`url(#${gridId})`} />
        {[25, 50].map((r) => (
          <g key={r} pointerEvents="none">
            <circle
              cx={focus.x}
              cy={-focus.y}
              r={r}
              className="fill-none stroke-line-strong"
              strokeDasharray="4 6"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            {layers.labels && (
              <Halo x={focus.x} y={-(focus.y + r) - 3 * k} k={k} size={9} anchor="middle" className="fill-faint" lines={[`${r} m`]} priority={8} />
            )}
          </g>
        ))}

        {/* Entorno real (OSM): referencial, por debajo de todo lo inferido */}
        {layers.surroundings && (envPath || envRoads) && (
          <g pointerEvents="none" aria-hidden="true">
            {envRoads && <path d={envRoads} className="fill-none stroke-faint/40" strokeWidth={1} vectorEffect="non-scaling-stroke" />}
            {envPath && (
              <path d={envPath} fillRule="evenodd" className="fill-faint/10 stroke-faint/45" strokeWidth={0.75} vectorEffect="non-scaling-stroke" />
            )}
          </g>
        )}
        {s.roads.map((r) => (
          <RoadShape key={r.id} road={r} k={k} labels={layers.labels} hatchId={hatchId} ctx={ctx} />
        ))}
        {layers.hazards && s.hazards.map((hz) => <HazardShape key={hz.id} h={hz} ctx={ctx} />)}
        {layers.structures && s.structures.map((st) => <StructureShape key={st.id} s={st} ctx={ctx} />)}
        {layers.fire && s.smokes.map((sm) => <SmokeShape key={sm.id} s={sm} ctx={ctx} />)}
        {layers.fire && s.fires.map((fz) => <FireShape key={fz.id} f={fz} fireGradId={fireGradId} ctx={ctx} />)}
        {layers.vehicles && s.vehicles.map((v) => <VehicleShape key={v.id} v={v} ctx={ctx} />)}
        {layers.access && s.access.map((a) => <AccessShape key={a.id} a={a} ctx={ctx} />)}
        {layers.cameras &&
          view.cameras.map((c) => (
            <CameraShape key={c.mediaRef} c={c} ctx={ctx} onOpen={onOpenMedia ? (l) => onOpenMedia(l) : undefined} />
          ))}
        {layers.drone && view.drones.map((d) => <DroneShape key={d.id} d={d} ctx={ctx} />)}
        {layers.labels &&
          s.annotations.map((n) => (
            <g key={n.id} pointerEvents="none">
              <circle cx={n.x} cy={-n.y} r={2.5 * k} className="fill-text" />
              <Halo x={n.x + 5 * k} y={-n.y + 3.5 * k} k={k} size={10} className="fill-text italic" lines={[n.text]} priority={20} />
            </g>
          ))}
        {layers.people && s.people.map((p) => <PersonShape key={p.id} p={p} ctx={ctx} />)}
      </svg>

      {/* Norte y escala */}
      <div className="pointer-events-none absolute bottom-[calc(var(--scene-hud-b,0px)+0.5rem)] left-[calc(var(--scene-hud-l,0px)+0.5rem)] z-10 flex items-end gap-3 rounded border border-line bg-surface/85 px-2 py-1 text-[10px] text-muted">
        <div className="flex flex-col items-center leading-none" aria-label="Norte hacia arriba">
          <svg width="12" height="16" viewBox="0 0 12 16" aria-hidden="true">
            <path d="M6 0 L11 14 L6 10.5 L1 14 Z" className="fill-text" />
          </svg>
          <span className="mt-0.5 font-display text-[11px] font-semibold text-text">N</span>
        </div>
        <div className="flex flex-col items-start gap-0.5">
          <div className="flex h-1.5 border border-text" style={{ width: Math.round(scalePx) }} aria-hidden="true">
            <div className="h-full w-1/2 bg-text" />
          </div>
          <span className="font-mono tabular">{scaleLen} m</span>
        </div>
      </div>

      {/* Zoom */}
      <div className="absolute right-[calc(var(--scene-hud-r,0px)+0.5rem)] bottom-[calc(var(--scene-hud-b,0px)+0.5rem)] z-10 flex flex-col overflow-hidden rounded border border-line bg-surface/90">
        <button type="button" onClick={() => zoomBy(1.5)} className="grid size-8 place-items-center text-muted hover:bg-surface-2 hover:text-text" aria-label="Acercar">
          <ZoomIn className="size-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => zoomBy(1 / 1.5)}
          disabled={zoom <= 1}
          className="grid size-8 place-items-center border-t border-line text-muted hover:bg-surface-2 hover:text-text disabled:opacity-40"
          aria-label="Alejar"
        >
          <ZoomOut className="size-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={reset}
          className="grid size-8 place-items-center border-t border-line text-muted hover:bg-surface-2 hover:text-text"
          aria-label="Reencuadrar"
          title="Reencuadrar"
        >
          <LocateFixed className="size-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

/* ───────────────────────────── Componente público ───────────────────────────── */

export type ScenePlan2DProps = Scene3DProps & {
  /** Capas iniciales (por defecto, todas visibles). */
  initialLayers?: LayerState;
};

/**
 * Planta 2D autónoma (mismas props que Scene3D): marco con leyenda, insignias,
 * simbología, supuestos e inspector. No carga three.js.
 */
export function ScenePlan2D(props: ScenePlan2DProps) {
  const {
    scene,
    incident,
    media,
    missions,
    engine,
    updatedAt,
    updating = false,
    selection,
    onSelect,
    onOpenMedia,
    compact = false,
    className,
    initialLayers,
  } = props;
  const view = useSceneView(scene, updatedAt, incident, media, missions);
  const [sel, select] = useSelection(selection, onSelect);
  const [layers, setLayers] = useState<LayerState>(initialLayers ?? DEFAULT_LAYERS);
  const env = useSceneSurroundings(incident, view?.scene.structures, layers.surroundings && !!view);
  return (
    <SceneFrame
      view={view}
      engine={engine}
      updatedAt={updatedAt}
      updating={updating}
      compact={compact}
      className={className}
      mode="2d"
      layers={layers}
      onLayersChange={setLayers}
      surroundingsStatus={env.status}
      surroundingsCount={env.data.buildings.length}
      selection={sel}
      onSelect={select}
      onOpenMedia={onOpenMedia}
    >
      {view ? (
        <PlanSvg view={view} layers={layers} selection={sel} onSelect={select} onOpenMedia={onOpenMedia} surroundings={env.data} />
      ) : (
        <SceneEmpty updating={updating} />
      )}
    </SceneFrame>
  );
}
