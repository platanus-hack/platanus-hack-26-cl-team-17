"use client";
/**
 * Visor de reconstrucción espacial (3D + planta 2D). Contrato en ./types.
 * - El lienzo 3D (three.js) se carga solo en el navegador con next/dynamic.
 * - Sin WebGL, o si el 3D falla, cae a la planta 2D en SVG.
 * - `compact` (tablet en ruta) abre en planta, sin capas ni inspector, con botón para ver en 3D.
 */
import { useCallback, useState } from "react";
import dynamic from "next/dynamic";
import { LoaderCircle } from "lucide-react";
import type { ViewPreset } from "./geometry";
import { DEFAULT_LAYERS, type LayerState } from "./layers";
import { useSceneView, useSelection, useStableByKey, useWebGLSupport } from "./hooks";
import { SceneEmpty, SceneFrame } from "./frame";
import { PlanSvg } from "./plan2d";
import { ViewerErrorBoundary } from "./error-boundary";
import { resolveMode, threeDBlockedReason, type ViewerMode } from "./three/pose";
import type { CameraPose, ViewRequest } from "./three/rig";
import type { Scene3DProps } from "./types";

export type { Scene3DProps, SceneSelection, SceneEntityKind } from "./types";
export { ScenePlan2D, type ScenePlan2DProps } from "./plan2d";

function Loading3D() {
  return (
    <div className="grid h-full min-h-[200px] place-items-center bg-bg" role="status">
      <span className="inline-flex items-center gap-2 text-[13px] text-muted">
        <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />
        Cargando vista 3D…
      </span>
    </div>
  );
}

const Viewer3D = dynamic(() => import("./viewer3d"), { ssr: false, loading: () => <Loading3D /> });

export function Scene3D(props: Scene3DProps) {
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
  } = props;
  const view = useSceneView(scene, updatedAt, incident, media, missions);
  const [sel, select] = useSelection(selection, onSelect);
  const [layers, setLayers] = useState<LayerState>(DEFAULT_LAYERS);
  const webgl = useWebGLSupport();
  const [chosen, setChosen] = useState<ViewerMode | null>(null);
  const [failed, setFailed] = useState(false);
  const [request, setRequest] = useState<ViewRequest | null>(null);
  // Última cámara del usuario en este incidente (sobrevive al cambio 3D ↔ planta).
  const poseRef = useStableByKey(incident.id, (): { current: CameraPose | null } => ({ current: null }));

  const mode = resolveMode({ compact, webgl, failed, chosen });
  const blocked = threeDBlockedReason({ webgl, failed });

  const onViewPreset = useCallback((preset: ViewPreset) => setRequest((r) => ({ preset, n: (r?.n ?? 0) + 1 })), []);
  const onFail = useCallback((error: unknown) => {
    console.warn("[scene3d] La vista 3D falló; se muestra la planta 2D.", error);
    setFailed(true);
  }, []);

  let body;
  if (!view) {
    body = <SceneEmpty updating={updating} />;
  } else if (mode === "2d") {
    body = <PlanSvg view={view} layers={layers} selection={sel} onSelect={select} onOpenMedia={onOpenMedia} />;
  } else if (webgl === null) {
    body = <Loading3D />;
  } else {
    body = (
      <ViewerErrorBoundary onError={onFail}>
        <Viewer3D
          key={incident.id}
          view={view}
          layers={layers}
          selection={sel}
          onSelect={select}
          onOpenMedia={onOpenMedia}
          request={request}
          poseRef={poseRef}
          compact={compact}
          onViewPreset={onViewPreset}
        />
      </ViewerErrorBoundary>
    );
  }

  const notice = failed
    ? "No se pudo dibujar la vista 3D en este equipo: se muestra la planta 2D."
    : webgl === false && !compact && view
      ? "Este navegador no permite gráficos 3D: se muestra la planta 2D."
      : null;

  return (
    <SceneFrame
      view={view}
      engine={engine}
      updatedAt={updatedAt}
      updating={updating}
      compact={compact}
      className={className}
      mode={mode}
      onToggleMode={() => setChosen(mode === "3d" ? "2d" : "3d")}
      toggleDisabledReason={blocked}
      layers={layers}
      onLayersChange={setLayers}
      selection={sel}
      onSelect={select}
      onOpenMedia={onOpenMedia}
      onViewPreset={mode === "3d" ? onViewPreset : undefined}
      notice={notice}
    >
      {body}
    </SceneFrame>
  );
}
