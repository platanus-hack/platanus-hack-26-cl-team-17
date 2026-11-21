"use client";
/**
 * Cámara: OrbitControls con límites (nunca bajo el suelo), encuadre automático solo la
 * primera vez (después se respeta la cámara del usuario), vistas rápidas animadas,
 * zoom por botones y actualización de la brújula y la barra de escala.
 */
import { useCallback, useEffect, useRef, type ComponentRef, type RefObject } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { clamp, fitView, niceScaleLength, type Bounds, type Vec3, type ViewPreset } from "../geometry";
import { clampTarget, easeInOut, metersPerPixel, viewHeadingDeg } from "./pose";

type Controls = ComponentRef<typeof OrbitControls>;

export interface CameraPose {
  position: Vec3;
  target: Vec3;
}

/** Pedido de vista rápida; `n` cambia en cada clic (permite repetir la misma vista). */
export interface ViewRequest {
  preset: ViewPreset;
  n: number;
}

export interface RigApi {
  zoom: (factor: number) => void;
}

const tuple = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z];

export interface CameraRigProps {
  frame: Bounds;
  extent: Bounds;
  frontHeadingDeg: number;
  groundSize: number;
  request: ViewRequest | null;
  /** Última pose del usuario (sobrevive al cambio 3D ↔ planta). */
  poseRef: RefObject<CameraPose | null>;
  apiRef: RefObject<RigApi | null>;
  reducedMotion: boolean;
}

interface Anim {
  fromP: THREE.Vector3;
  toP: THREE.Vector3;
  fromT: THREE.Vector3;
  toT: THREE.Vector3;
  t0: number;
  dur: number;
}

export function CameraRig({ frame, extent, frontHeadingDeg, groundSize, request, poseRef, apiRef, reducedMotion }: CameraRigProps) {
  const get = useThree((s) => s.get);
  const controls = useRef<Controls>(null);
  const anim = useRef<Anim | null>(null);
  const fitted = useRef(false);
  const lastRequest = useRef(request?.n ?? 0);

  const savePose = useCallback(() => {
    const c = controls.current;
    if (!c) return;
    poseRef.current = { position: tuple(get().camera.position), target: tuple(c.target) };
  }, [get, poseRef]);

  const goTo = useCallback(
    (pose: CameraPose, instant: boolean) => {
      const { camera, invalidate } = get();
      const c = controls.current;
      if (!c) return;
      if (instant) {
        anim.current = null;
        camera.position.set(...pose.position);
        c.target.set(...pose.target);
        c.update();
        savePose();
      } else {
        anim.current = {
          fromP: camera.position.clone(),
          toP: new THREE.Vector3(...pose.position),
          fromT: c.target.clone(),
          toT: new THREE.Vector3(...pose.target),
          t0: performance.now(),
          dur: 650,
        };
      }
      invalidate();
    },
    [get, savePose],
  );

  const fit = useCallback(
    (preset: ViewPreset): CameraPose => {
      const { size, camera } = get();
      const fov = camera instanceof THREE.PerspectiveCamera ? camera.fov : 45;
      const f = fitView(frame, preset, frontHeadingDeg, size.width / Math.max(1, size.height), fov);
      return { position: f.position, target: f.target };
    },
    [get, frame, frontHeadingDeg],
  );

  // Primer encuadre: la pose previa del usuario (si vuelve desde la planta) o isométrica al contenido.
  useEffect(() => {
    if (fitted.current) return;
    fitted.current = true;
    goTo(poseRef.current ?? fit("iso"), true);
  }, [goTo, fit, poseRef]);

  useEffect(() => {
    if (!request || request.n === lastRequest.current) return;
    lastRequest.current = request.n;
    goTo(fit(request.preset), reducedMotion);
  }, [request, goTo, fit, reducedMotion]);

  useEffect(() => {
    apiRef.current = {
      zoom: (factor: number) => {
        const c = controls.current;
        if (!c) return;
        const { camera } = get();
        const off = camera.position.clone().sub(c.target);
        off.setLength(clamp(off.length() * factor, c.minDistance, c.maxDistance));
        goTo({ position: tuple(c.target.clone().add(off)), target: tuple(c.target) }, reducedMotion);
      },
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, get, goTo, reducedMotion]);

  const margin = 30;
  useFrame((state) => {
    const c = controls.current;
    if (!c) return;
    const a = anim.current;
    if (a) {
      const k = easeInOut((performance.now() - a.t0) / a.dur);
      state.camera.position.lerpVectors(a.fromP, a.toP, k);
      c.target.lerpVectors(a.fromT, a.toT, k);
      c.update();
      if (k >= 1) {
        anim.current = null;
        savePose();
      }
      state.invalidate();
      return;
    }
    // El objetivo no puede salir del suelo dibujado: se corre la cámara junto con él.
    const t = c.target;
    const [x, y, z] = clampTarget([t.x, t.y, t.z], extent, margin);
    if (x !== t.x || y !== t.y || z !== t.z) {
      state.camera.position.add(new THREE.Vector3(x - t.x, y - t.y, z - t.z));
      t.set(x, y, z);
      c.update();
      state.invalidate();
    }
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      dampingFactor={0.12}
      screenSpacePanning={false}
      minDistance={4}
      maxDistance={clamp(groundSize * 1.6, 220, 2600)}
      minPolarAngle={0}
      maxPolarAngle={Math.PI / 2 - 0.06}
      zoomToCursor
      onEnd={savePose}
    />
  );
}

/** Actualiza la brújula y la barra de escala (DOM fuera del lienzo) sin re-renderizar React. */
export function HudUpdater({
  compassRef,
  scaleBarRef,
  scaleTextRef,
}: {
  compassRef: RefObject<HTMLElement | null>;
  scaleBarRef: RefObject<HTMLElement | null>;
  scaleTextRef: RefObject<HTMLElement | null>;
}) {
  const last = useRef({ heading: NaN, len: NaN, px: NaN });
  useFrame((state) => {
    const ctl = state.controls as unknown as { target?: THREE.Vector3 } | null;
    const target = ctl?.target;
    if (!(target instanceof THREE.Vector3)) return;
    const cam = state.camera;
    const heading = Math.round(viewHeadingDeg(tuple(cam.position), tuple(target)));
    const fov = cam instanceof THREE.PerspectiveCamera ? cam.fov : 45;
    const mpp = metersPerPixel(cam.position.distanceTo(target), fov, state.size.height);
    const len = niceScaleLength(mpp, 80);
    const px = Math.round(len / mpp);
    const prev = last.current;
    const compass = compassRef.current;
    if (heading !== prev.heading && compass) compass.style.transform = `rotate(${-heading}deg)`;
    const bar = scaleBarRef.current;
    const text = scaleTextRef.current;
    if ((len !== prev.len || px !== prev.px) && bar && text) {
      bar.style.width = `${clamp(px, 8, 220)}px`;
      text.textContent = `≈ ${len} m`;
    }
    last.current = { heading, len, px };
  });
  return null;
}
