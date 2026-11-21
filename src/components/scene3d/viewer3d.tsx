"use client";
/**
 * Lienzo 3D del visor (three.js + @react-three/fiber). Se carga solo en el navegador
 * con next/dynamic desde index.tsx; nunca usa recursos de red (fuentes, HDR, texturas).
 */
import { useCallback, useMemo, useRef, useState, type RefObject } from "react";
import { Canvas } from "@react-three/fiber";
import { LocateFixed, ZoomIn, ZoomOut } from "lucide-react";
import { groundSize, type ViewPreset } from "./geometry";
import { hasAnimatedContent, type SceneView } from "./model";
import type { LayerState } from "./layers";
import { DEFAULT_PALETTE, readPalette, type Palette } from "./palette";
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
import { coreBounds, shouldAnimate } from "./three/pose";

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
}

function samePalette(a: Palette, b: Palette): boolean {
  return (Object.keys(a) as (keyof Palette)[]).every((k) => a[k] === b[k]);
}

const HUD_BUTTON = "grid size-8 place-items-center text-muted hover:bg-surface-2 hover:text-text";

export default function Viewer3D(props: Viewer3DProps) {
  const { view, layers, selection, onSelect, onOpenMedia, request, poseRef, compact, onViewPreset } = props;
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

  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [labelRegistry] = useState(() => new LabelRegistry());
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

  return (
    <div ref={attachHost} className="absolute inset-0 isolate overflow-hidden bg-bg">
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
          <color attach="background" args={[palette.bg]} />
          <hemisphereLight args={["#dbe6f2", "#1a222c", 1.6]} />
          <directionalLight position={[60, 120, 40]} intensity={1.5} />
          <ambientLight intensity={0.4} />
          <CameraRig
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
          <HudUpdater compassRef={compassRef} scaleBarRef={scaleBarRef} scaleTextRef={scaleTextRef} />
          <Ground size={gSize} center={gCenter} focus={s.focus} />
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
      <div ref={overlayRef} className="pointer-events-none absolute inset-0 z-10 overflow-hidden" />

      {/* Norte y escala (se actualizan desde el lienzo) */}
      <div className="pointer-events-none absolute bottom-2 left-2 z-50 flex items-end gap-3 rounded border border-line bg-surface/85 px-2 py-1 text-[10px] text-muted">
        <div className="flex flex-col items-center leading-none" aria-label="Norte">
          <div ref={compassRef} className="grid size-5 place-items-center" aria-hidden="true">
            <svg width="12" height="16" viewBox="0 0 12 16">
              <path d="M6 0 L11 14 L6 10.5 L1 14 Z" className="fill-critical" />
            </svg>
          </div>
          <span className="mt-0.5 font-display text-[11px] font-semibold text-text">N</span>
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

      <div className="absolute right-2 bottom-2 z-50 flex flex-col overflow-hidden rounded border border-line bg-surface/90">
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
