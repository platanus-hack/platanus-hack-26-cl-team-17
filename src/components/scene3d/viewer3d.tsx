"use client";
/**
 * Lienzo 3D del visor (three.js + @react-three/fiber). Se carga solo en el navegador
 * con next/dynamic desde index.tsx; sin recursos de red (fuentes, HDR, texturas). El
 * entorno OSM llega ya descargado por props (surroundings-data.ts).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { Canvas } from "@react-three/fiber";
import { LocateFixed, ZoomIn, ZoomOut } from "lucide-react";
import { groundSize, type ViewPreset } from "./geometry";
import { hasAnimatedContent, type SceneView } from "./model";
import type { LayerState } from "./layers";
import { DEFAULT_PALETTE, readPalette, SCENE_BG, type Palette } from "./palette";
import type { SceneSelection } from "./types";
import { useOnScreen, usePageVisible, useReducedMotion } from "./hooks";
import { SceneCtx, type SceneCtxValue } from "./three/context";
import { Ground, Roads } from "./three/ground";
import { Structures } from "./three/structures";
import { Fires, Smokes } from "./three/fire";
import { People } from "./three/people";
import { Vehicles } from "./three/vehicles";
import { AccessPoints, Annotations, Hazards } from "./three/markers";
import { Drones, MediaCameras } from "./three/cameras";
import { CameraRig, HudUpdater, type CameraPose, type RigApi, type ViewRequest } from "./three/rig";
import { LabelLayout, LabelRegistry } from "./three/label";
import { SurroundingsLayer } from "./three/surroundings";
import type { Surroundings } from "./surroundings";
import { coreBounds, shouldAnimate } from "./three/pose";
import { NO_INSETS, readInsets, SafeViewport, sameInsets, type Insets } from "./three/viewport";

export interface Viewer3DProps {
  view: SceneView;
  layers: LayerState;
  selection: SceneSelection | null;
  onSelect: (sel: SceneSelection | null) => void;
  onOpenMedia?: (mediaLabel: string, frame?: number) => void;
  request: ViewRequest | null;
  poseRef: RefObject<CameraPose | null>;
  compact: boolean;
  /** Vista rápida pedida desde el propio lienzo (botón Reencuadrar). */
  onViewPreset: (preset: ViewPreset) => void;
  /** Entorno real (OSM) ya filtrado; no participa del encuadre. */
  surroundings: Surroundings;
}

function samePalette(a: Palette, b: Palette): boolean {
  return (Object.keys(a) as (keyof Palette)[]).every((k) => a[k] === b[k]);
}

/** Las etiquetas solo se ven en el hueco que dejan los paneles flotantes. */
const OVERLAY_CLIP: CSSProperties = {
  clipPath: "inset(var(--scene-hud-t,0px) var(--scene-hud-r,0px) var(--scene-hud-b,0px) var(--scene-hud-l,0px))",
};

const HUD_BUTTON = "grid size-8 place-items-center text-muted hover:bg-surface-2 hover:text-text";

/** Cinta de rumbo: 4 px por grado, marcas cada 5° y rótulo cada 10° (decenas, como "01" = 10°; N/E/S/O en los cardinales). */
const TAPE_PX = 4;
const TAPE_DEGS = Array.from({ length: (1080 / 5) + 1 }, (_, i) => i * 5 - 360);
const CARDINAL: Record<number, string> = { 0: "N", 90: "E", 180: "S", 270: "O" };
function tapeLabel(d: number): string {
  const n = ((d % 360) + 360) % 360;
  return CARDINAL[n] ?? String(n / 10).padStart(2, "0");
}

export default function Viewer3D(props: Viewer3DProps) {
  const { view, layers, selection, onSelect, onOpenMedia, request, poseRef, compact, onViewPreset, surroundings } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [palette, setPalette] = useState<Palette>(DEFAULT_PALETTE);
  // Los colores del 3D salen de las variables CSS del tema donde está montado el visor.
  const attachHost = useCallback((el: HTMLDivElement | null) => {
    hostRef.current = el;
    if (!el) return;
    const next = readPalette(el);
    setPalette((prev) => (samePalette(prev, next) ? prev : next));
  }, []);

  const reducedMotion = useReducedMotion();
  const pageVisible = usePageVisible();
  const onScreen = useOnScreen(hostRef);
  const animate = shouldAnimate({ content: hasAnimatedContent(view), reducedMotion, pageVisible, onScreen });

  const setHover = useCallback((on: boolean) => {
    const el = hostRef.current;
    if (el) el.style.cursor = on ? "pointer" : "";
  }, []);

  // Márgenes tapados por los paneles flotantes (variables CSS del contenedor). Se sondean
  // porque cambian al mostrar u ocultar paneles sin que el lienzo cambie de tamaño.
  const insetsRef = useRef<Insets>(NO_INSETS);
  const [insetsVersion, setInsetsVersion] = useState(0);
  useEffect(() => {
    const read = () => {
      const el = hostRef.current;
      if (!el) return;
      const next = readInsets(el);
      if (sameInsets(next, insetsRef.current)) return;
      insetsRef.current = next;
      setInsetsVersion((v) => v + 1);
    };
    read();
    const id = window.setInterval(read, 400);
    return () => window.clearInterval(id);
  }, []);

  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [labelRegistry] = useState(() => new LabelRegistry());
  useEffect(() => {
    labelRegistry.setClip(() => {
      const el = hostRef.current;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const i = insetsRef.current;
      return new DOMRect(r.left + i.l, r.top + i.t, Math.max(0, r.width - i.l - i.r), Math.max(0, r.height - i.t - i.b));
    });
    return () => labelRegistry.setClip(null);
  }, [labelRegistry]);
  useEffect(() => labelRegistry.touch(), [labelRegistry, insetsVersion]);
  const ctx = useMemo<SceneCtxValue>(
    () => ({
      palette,
      labels: layers.labels,
      compact,
      animate,
      selection,
      select: onSelect,
      openMedia: onOpenMedia,
      setHover,
      overlayRef,
      labelRegistry,
    }),
    [palette, layers.labels, compact, animate, selection, onSelect, onOpenMedia, setHover, labelRegistry],
  );

  const s = view.scene;
  const core = useMemo(() => coreBounds(view.scene, view.frame), [view.scene, view.frame]);
  const gSize = groundSize(view.extent, s.focus);
  const gCenter = useMemo(() => ({ x: Math.round(s.focus.x / 10) * 10, y: Math.round(s.focus.y / 10) * 10 }), [s.focus.x, s.focus.y]);

  const apiRef = useRef<RigApi | null>(null);
  const compassRef = useRef<HTMLDivElement>(null);
  const scaleBarRef = useRef<HTMLDivElement>(null);
  const scaleTextRef = useRef<HTMLSpanElement>(null);
  const tapeRef = useRef<HTMLDivElement>(null);
  const headingTextRef = useRef<HTMLSpanElement>(null);
  const reticle = compact ? 96 : 132;

  return (
    <div ref={attachHost} className="absolute inset-0 isolate overflow-hidden" style={{ background: SCENE_BG }}>
      <Canvas
        frameloop={animate ? "always" : "demand"}
        dpr={[1, 1.75]}
        flat
        gl={{ antialias: true, powerPreference: "high-performance" }}
        camera={{ fov: 45, near: 0.5, far: 8000, position: [60, 50, 60] }}
        onPointerMissed={() => onSelect(null)}
        role="group"
        aria-label="Vista 3D de la reconstrucción. Arrastra para girar, rueda o pellizca para acercar."
      >
        <SceneCtx.Provider value={ctx}>
          {/* Lámina técnica: fondo gris claro, neblina hacia el horizonte y luz de maqueta blanca. */}
          <color attach="background" args={[SCENE_BG]} />
          <fog attach="fog" args={[SCENE_BG, Math.max(gSize * 0.45, 120), gSize * 1.2 + 150]} />
          <hemisphereLight args={["#ffffff", "#c3c9d0", 1.5]} />
          <directionalLight position={[-60, 140, 80]} intensity={1.3} />
          <ambientLight intensity={0.35} />
          <SafeViewport insetsRef={insetsRef} version={insetsVersion} />
          <CameraRig
            insetsRef={insetsRef}
            frame={view.frame}
            core={core}
            extent={view.extent}
            frontHeadingDeg={s.frontHeadingDeg}
            groundSize={gSize}
            request={request}
            poseRef={poseRef}
            apiRef={apiRef}
            reducedMotion={reducedMotion}
          />
          <HudUpdater compassRef={compassRef} scaleBarRef={scaleBarRef} scaleTextRef={scaleTextRef} tapeRef={tapeRef} headingTextRef={headingTextRef} tapePxPerDeg={TAPE_PX} />
          <Ground size={gSize} center={gCenter} focus={s.focus} />
          {layers.surroundings && <SurroundingsLayer buildings={surroundings.buildings} roadSegments={surroundings.roadSegments} />}
          <Roads roads={s.roads} focus={s.focus} />
          {layers.hazards && <Hazards items={s.hazards} />}
          {layers.structures && <Structures items={s.structures} fires={s.fires} />}
          {layers.fire && <Fires items={s.fires} />}
          {layers.fire && <Smokes items={s.smokes} />}
          {layers.vehicles && <Vehicles items={s.vehicles} />}
          {layers.access && <AccessPoints items={s.access} />}
          {layers.cameras && <MediaCameras items={view.cameras} focus={s.focus} />}
          {layers.drone && <Drones items={view.drones} />}
          {layers.labels && <Annotations items={s.annotations} />}
          {layers.people && <People items={s.people} />}
          <LabelLayout registry={labelRegistry} />
        </SceneCtx.Provider>
      </Canvas>

      {/* Etiquetas HTML de la escena (drei <Html>); deja pasar los gestos al lienzo */}
      <div ref={overlayRef} className="pointer-events-none absolute inset-0 z-10 overflow-hidden" style={OVERLAY_CLIP} />

      {/* Hueco visible (entre paneles): retícula en el centro de la órbita y cinta de rumbo. */}
      <div
        aria-hidden="true"
        className="@container pointer-events-none absolute top-[var(--scene-hud-t,0px)] right-[var(--scene-hud-r,0px)] bottom-[var(--scene-hud-b,0px)] left-[var(--scene-hud-l,0px)] z-20"
      >
        <div className="absolute top-1/2 left-0 h-px bg-text/15" style={{ width: `calc(50% - ${reticle / 2 + 18}px)` }} />
        <div className="absolute top-1/2 right-0 h-px bg-text/15" style={{ width: `calc(50% - ${reticle / 2 + 18}px)` }} />
        <div className="absolute top-0 left-1/2 w-px bg-text/15" style={{ height: `calc(50% - ${reticle / 2 + 18}px)` }} />
        <div className="absolute bottom-0 left-1/2 w-px bg-text/15" style={{ height: `calc(50% - ${reticle / 2 + 18}px)` }} />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" style={{ width: reticle, height: reticle }}>
          <span className="absolute top-0 left-0 size-4 border-t border-l border-text/60" />
          <span className="absolute top-0 right-0 size-4 border-t border-r border-text/60" />
          <span className="absolute bottom-0 left-0 size-4 border-b border-l border-text/60" />
          <span className="absolute right-0 bottom-0 size-4 border-r border-b border-text/60" />
          <span className="absolute inset-[30%] rounded-full border border-dashed border-text/35" />
        </div>

        {/* Cinta de rumbo (hacia dónde mira la cámara); solo si cabe entre la escala y el zoom. */}
        {!compact && (
          <div className="absolute bottom-3 left-1/2 hidden -translate-x-1/2 flex-col items-center text-text/70 @min-[34rem]:flex">
            <div className="relative h-6 w-[200px] overflow-hidden [mask-image:linear-gradient(90deg,transparent,#000_20%,#000_80%,transparent)]">
              <div ref={tapeRef} className="absolute top-0 left-1/2 h-full">
                {TAPE_DEGS.map((d) => (
                  <span key={d} className="absolute top-0 flex -translate-x-1/2 flex-col items-center" style={{ left: (d + 360) * TAPE_PX }}>
                    <span className={d % 10 === 0 ? "h-2 w-px bg-text/60" : "h-1 w-px bg-text/35"} />
                    {d % 10 === 0 && <span className="mt-0.5 font-mono text-[10px] leading-none">{tapeLabel(d)}</span>}
                  </span>
                ))}
              </div>
            </div>
            <span className="mt-0.5 font-mono text-[11px] leading-none text-text">
              ↑ <span ref={headingTextRef}>000°</span>
            </span>
          </div>
        )}
      </div>

      {/* Norte y escala (se actualizan desde el lienzo) */}
      <div className="pointer-events-none absolute bottom-[calc(var(--scene-hud-b,0px)+0.5rem)] left-[calc(var(--scene-hud-l,0px)+0.5rem)] z-50 flex items-end gap-3 rounded-[2px] border border-line-strong bg-surface/80 px-2 py-1 font-mono text-[10px] text-muted">
        <div className="flex flex-col items-center leading-none" aria-label="Norte">
          <div ref={compassRef} className="grid size-5 place-items-center" aria-hidden="true">
            <svg width="12" height="16" viewBox="0 0 12 16">
              <path d="M6 0 L11 14 L6 10.5 L1 14 Z" className="fill-text" />
            </svg>
          </div>
          <span className="mt-0.5 font-mono text-[11px] font-semibold text-text">N</span>
        </div>
        <div className="flex flex-col items-start gap-0.5">
          <div ref={scaleBarRef} className="flex h-1.5 border border-text" style={{ width: 80 }} aria-hidden="true">
            <div className="h-full w-1/2 bg-text" />
          </div>
          <span ref={scaleTextRef} className="font-mono tabular" title="Escala aproximada a la distancia del centro de la vista">
            ≈ 20 m
          </span>
        </div>
      </div>

      <div className="absolute right-[calc(var(--scene-hud-r,0px)+0.5rem)] bottom-[calc(var(--scene-hud-b,0px)+0.5rem)] z-50 flex flex-col overflow-hidden rounded-[2px] border border-line-strong bg-surface/90">
        <button type="button" onClick={() => apiRef.current?.zoom(1 / 1.5)} className={HUD_BUTTON} aria-label="Acercar" title="Acercar">
          <ZoomIn className="size-4" aria-hidden="true" />
        </button>
        <button type="button" onClick={() => apiRef.current?.zoom(1.5)} className={`${HUD_BUTTON} border-t border-line`} aria-label="Alejar" title="Alejar">
          <ZoomOut className="size-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => onViewPreset("iso")}
          className={`${HUD_BUTTON} border-t border-line`}
          aria-label="Reencuadrar"
          title="Reencuadrar"
        >
          <LocateFixed className="size-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
