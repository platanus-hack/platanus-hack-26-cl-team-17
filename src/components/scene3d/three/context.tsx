"use client";
/**
 * Estado compartido dentro del lienzo 3D (paleta, capas de etiquetas, selección).
 * El Canvas de @react-three/fiber puentea el contexto de React; los <Html> de drei
 * NO (son raíces aparte): sus hijos reciben los datos por props.
 */
import { createContext, useContext, useMemo, type RefObject } from "react";
import type { ThreeEvent } from "@react-three/fiber";
import type { Palette } from "../palette";
import type { SceneEntityKind, SceneSelection } from "../types";
import { choosePick } from "./pose";

export interface SceneCtxValue {
  palette: Palette;
  /** Capa Etiquetas activa. */
  labels: boolean;
  compact: boolean;
  /** Animaciones activas (contenido animable, sin movimiento reducido y visor visible). */
  animate: boolean;
  selection: SceneSelection | null;
  select: (sel: SceneSelection | null) => void;
  openMedia?: (mediaLabel: string, frame?: number) => void;
  setHover: (on: boolean) => void;
  /** Capa HTML fija donde se montan las etiquetas (destino estable para drei <Html>). */
  overlayRef: RefObject<HTMLDivElement | null>;
}

export const SceneCtx = createContext<SceneCtxValue | null>(null);

export function useSceneCtx(): SceneCtxValue {
  const v = useContext(SceneCtx);
  if (!v) throw new Error("Falta el contexto del visor 3D");
  return v;
}

export function useIsSelected(kind: SceneEntityKind, id: string): boolean {
  const { selection } = useSceneCtx();
  return selection?.kind === kind && selection.id === id;
}

export interface PickProps {
  userData: { vgPick: SceneSelection };
  onClick: (e: ThreeEvent<MouseEvent>) => void;
  onPointerOver: (e: ThreeEvent<PointerEvent>) => void;
  onPointerOut: () => void;
}

/** Props de un grupo seleccionable con clic (entre entidades superpuestas gana la de mayor prioridad). */
export function usePick(kind: SceneEntityKind, id: string, after?: () => void): PickProps {
  const { select, setHover } = useSceneCtx();
  return useMemo(
    () => ({
      userData: { vgPick: { kind, id } },
      onClick: (e: ThreeEvent<MouseEvent>) => {
        // Un arrastre para orbitar no es un clic.
        if (e.delta > 4) return;
        e.stopPropagation();
        const best = choosePick(e.intersections) ?? { kind, id };
        select(best);
        if (best.kind === kind && best.id === id) after?.();
      },
      onPointerOver: (e: ThreeEvent<PointerEvent>) => {
        e.stopPropagation();
        setHover(true);
      },
      onPointerOut: () => setHover(false),
    }),
    [kind, id, select, setHover, after],
  );
}
