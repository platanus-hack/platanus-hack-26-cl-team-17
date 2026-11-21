"use client";
/**
 * Hueco visible del lienzo: cuando el visor ocupa todo el fondo y hay paneles flotantes
 * encima (variables CSS --scene-hud-*), la cámara proyecta la vista dentro de ese hueco
 * con setViewOffset. Así el centro de la órbita, el encuadre y la escala quedan en lo
 * que de verdad se ve, no detrás de los paneles.
 */
import { useEffect, type RefObject } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";

/** Márgenes en px tapados por la interfaz (arriba, derecha, abajo, izquierda). */
export interface Insets {
  t: number;
  r: number;
  b: number;
  l: number;
}

export const NO_INSETS: Insets = { t: 0, r: 0, b: 0, l: 0 };

/** Lee los márgenes de las variables CSS del contenedor (0 si no existen). */
export function readInsets(el: Element): Insets {
  const cs = getComputedStyle(el);
  const n = (k: string) => Math.max(0, parseFloat(cs.getPropertyValue(k)) || 0);
  return { t: n("--scene-hud-t"), r: n("--scene-hud-r"), b: n("--scene-hud-b"), l: n("--scene-hud-l") };
}

export function sameInsets(a: Insets, b: Insets): boolean {
  return a.t === b.t && a.r === b.r && a.b === b.b && a.l === b.l;
}

/** Rectángulo útil; `active` = false si no hay márgenes o el hueco es demasiado chico (se usa todo el lienzo). */
export function safeRect(size: { width: number; height: number }, i: Insets) {
  const w = size.width - i.l - i.r;
  const h = size.height - i.t - i.b;
  const active = (i.t || i.r || i.b || i.l) > 0 && w >= 200 && h >= 140;
  return active ? { active, l: i.l, t: i.t, w, h } : { active, l: 0, t: 0, w: size.width, h: size.height };
}

/** Ajusta la proyección de la cámara al hueco útil; `version` cambia cuando cambian los márgenes. */
export function SafeViewport({ insetsRef, version }: { insetsRef: RefObject<Insets>; version: number }) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    invalidate();
  }, [version, invalidate]);
  useFrame(({ camera, size }) => {
    if (!(camera instanceof THREE.PerspectiveCamera)) return;
    const r = safeRect(size, insetsRef.current);
    const v = camera.view;
    if (!r.active) {
      if (v?.enabled) {
        camera.clearViewOffset();
        camera.aspect = size.width / Math.max(1, size.height);
        camera.updateProjectionMatrix();
      }
      return;
    }
    const aspect = r.w / r.h;
    const same =
      v?.enabled &&
      v.fullWidth === r.w &&
      v.fullHeight === r.h &&
      v.offsetX === -r.l &&
      v.offsetY === -r.t &&
      v.width === size.width &&
      v.height === size.height &&
      camera.aspect === aspect;
    if (same) return;
    camera.aspect = aspect;
    // Ventana del tamaño del hueco, corrida para que el lienzo completo siga dibujándose.
    camera.setViewOffset(r.w, r.h, -r.l, -r.t, size.width, size.height);
  });
  return null;
}
