"use client";
/**
 * Lienzo de la reconstrucción 3D en vivo (three.js). Se carga solo en el navegador con
 * next/dynamic desde Live3D.tsx, para no agrandar el paquete principal.
 *
 * Los puntos y las cámaras vienen en el sistema del mundo del servicio; un <group> con la
 * matriz `display` (mundo → vista: Y arriba, centrada, ~1 unidad) los lleva a la escena.
 * Colores: el lienzo es `linear` (sin conversión sRGB) para que los colores de los puntos
 * (bytes sRGB del video) se vean tal cual; los colores fijos se dan ya en esos valores.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Line, OrbitControls } from "@react-three/drei";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { Live3DStatus } from "@/lib/drone/live3d-types";
import { cameraCenter, frustumSegments, matrixScale, robustBounds, type PointCloudBuffer } from "@/lib/drone/live3d-points";

/**
 * Tamaño del punto y del frustum del dron, en fracción del radio de la nube (en vista). Así se
 * ven igual aunque `display` no deje la escena exactamente en ~1 unidad.
 */
const POINT_SIZE_PER_RADIUS = 0.018;
const FRUSTUM_PER_RADIUS = 0.08;
const FOV = 50;
/** Se vuelve a encuadrar si la nube crece más que esto respecto del último encuadre. */
const REFRAME_GROWTH = 1.4;

const rgb = (r: number, g: number, b: number) => new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace);
const BG: [number, number, number] = [0.035, 0.043, 0.06];
const ACCENT = rgb(1, 0.62, 0.1);
const TRAIL = rgb(0.35, 0.8, 1);

export interface Live3DCanvasProps {
  status: Live3DStatus;
  cloud: PointCloudBuffer;
  /** Sube cuando la nube cambia (se mutan los mismos arreglos). */
  cloudVersion: number;
}

function Cloud({ cloud, cloudVersion, pointSize }: { cloud: PointCloudBuffer; cloudVersion: number; pointSize: number }) {
  const pointsRef = useRef<THREE.Points>(null);
  const synced = useRef<{ geom: THREE.BufferGeometry; gen: number; count: number } | null>(null);
  useLayoutEffect(() => {
    const pts = pointsRef.current;
    if (!pts) return;
    let s = synced.current;
    if (!s || s.gen !== cloud.generation) {
      // Arreglos nuevos (crecieron o se vació la nube): geometría nueva y se libera la anterior.
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(cloud.positions, 3).setUsage(THREE.DynamicDrawUsage));
      geom.setAttribute("color", new THREE.BufferAttribute(cloud.colors, 3, true).setUsage(THREE.DynamicDrawUsage));
      const old = pts.geometry;
      pts.geometry = geom;
      old?.dispose();
      s = synced.current = { geom, gen: cloud.generation, count: cloud.count };
    } else if (cloud.count > s.count) {
      // Solo se sube a la GPU lo agregado.
      for (const name of ["position", "color"] as const) {
        const attr = s.geom.getAttribute(name) as THREE.BufferAttribute;
        attr.addUpdateRange(s.count * 3, (cloud.count - s.count) * 3);
        attr.needsUpdate = true;
      }
      s.count = cloud.count;
    }
    s.geom.setDrawRange(0, cloud.count);
  }, [cloud, cloudVersion]);

  useEffect(() => () => synced.current?.geom.dispose(), []);

  // Sin recorte por frustum: la esfera envolvente cambia con cada trozo y la nube es una sola.
  return (
    <points ref={pointsRef} frustumCulled={false}>
      <pointsMaterial size={pointSize} sizeAttenuation vertexColors />
    </points>
  );
}

function Trajectory({ cameras, display, size }: { cameras: number[][]; display: number[]; size: number }) {
  // Tamaños en unidades de vista pasados al mundo (el grupo aplica `display`).
  const scale = matrixScale(display) / size;
  const centers = useMemo(() => cameras.map((c) => new THREE.Vector3(...cameraCenter(c))), [cameras]);
  const last = cameras.at(-1) ?? null;
  const frustum = useMemo(
    () => (last ? frustumSegments(last, FRUSTUM_PER_RADIUS / scale).map((p) => new THREE.Vector3(...p)) : null),
    [last, scale],
  );
  return (
    <>
      {centers.length >= 2 && <Line points={centers} color={TRAIL} lineWidth={2} transparent opacity={0.85} />}
      {frustum && <Line points={frustum} segments color={ACCENT} lineWidth={2.5} />}
      {last && (
        <mesh position={cameraCenter(last)} scale={0.012 / scale}>
          <sphereGeometry args={[1, 12, 12]} />
          <meshBasicMaterial color={ACCENT} />
        </mesh>
      )}
    </>
  );
}

/** Encuadra la nube al llegar el primer trozo y cuando crece mucho; nunca después de que el usuario movió la vista. */
function AutoFrame({ bounds, interacted }: { bounds: { center: [number, number, number]; radius: number } | null; interacted: boolean }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const framedRadius = useRef(0);
  const anim = useRef<{ fromPos: THREE.Vector3; toPos: THREE.Vector3; fromTarget: THREE.Vector3; toTarget: THREE.Vector3; t: number } | null>(null);

  useEffect(() => {
    if (interacted) {
      anim.current = null;
      return;
    }
    if (!bounds || !controls) return;
    if (framedRadius.current > 0 && bounds.radius < framedRadius.current * REFRAME_GROWTH) return;
    const first = framedRadius.current === 0;
    framedRadius.current = bounds.radius;
    const target = new THREE.Vector3(...bounds.center);
    const persp = camera as THREE.PerspectiveCamera;
    const aspect = persp.aspect > 0 ? persp.aspect : 1;
    const halfV = THREE.MathUtils.degToRad(FOV / 2);
    const halfH = Math.atan(Math.tan(halfV) * aspect);
    const dist = (bounds.radius / Math.sin(Math.min(halfV, halfH))) * 1.05;
    // La primera vez desde arriba en diagonal; después se conserva el ángulo actual (sigue girando).
    const dir = first
      ? new THREE.Vector3(1, 0.85, 1).normalize()
      : camera.position.clone().sub(controls.target).normalize();
    if (!Number.isFinite(dir.x) || dir.lengthSq() < 0.5) dir.set(1, 0.85, 1).normalize();
    anim.current = {
      fromPos: camera.position.clone(),
      toPos: target.clone().addScaledVector(dir, dist),
      fromTarget: controls.target.clone(),
      toTarget: target,
      t: 0,
    };
  }, [bounds, interacted, camera, controls]);

  useFrame((_, dt) => {
    const a = anim.current;
    if (!a || !controls) return;
    a.t = Math.min(1, a.t + dt / 0.9);
    const k = 1 - (1 - a.t) ** 3;
    camera.position.lerpVectors(a.fromPos, a.toPos, k);
    controls.target.lerpVectors(a.fromTarget, a.toTarget, k);
    controls.update();
    if (a.t >= 1) anim.current = null;
  });
  return null;
}

function SceneContent({ status, cloud, cloudVersion }: Live3DCanvasProps) {
  const groupRef = useRef<THREE.Group>(null);
  const [interacted, setInteracted] = useState(false);
  const display = status.display;

  useLayoutEffect(() => {
    const g = groupRef.current;
    if (!g) return;
    const d = display;
    g.matrix.set(d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7], d[8], d[9], d[10], d[11], d[12], d[13], d[14], d[15]);
    g.matrixWorldNeedsUpdate = true;
  }, [display]);

  // Encuadre robusto en coordenadas de vista, desde la muestra de la nube (la nube se muta en
  // su lugar; la muestra solo cambia cuando cambia la cantidad de puntos).
  const count = cloud.count;
  const bounds = useMemo(() => (count > 0 ? robustBounds(cloud.samples, display) : null), [cloud, count, display]);
  const radius = bounds?.radius ?? 1;
  const pointSize = THREE.MathUtils.clamp(radius * POINT_SIZE_PER_RADIUS, 0.004, 0.25);

  return (
    <>
      <color attach="background" args={BG} />
      <group ref={groupRef} matrixAutoUpdate={false}>
        <Cloud cloud={cloud} cloudVersion={cloudVersion} pointSize={pointSize} />
        <Trajectory cameras={status.cameras} display={display} size={radius} />
      </group>
      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.12}
        autoRotate={!interacted}
        autoRotateSpeed={0.6}
        onStart={() => setInteracted(true)}
      />
      <AutoFrame bounds={bounds} interacted={interacted} />
    </>
  );
}

export default function Live3DCanvas(props: Live3DCanvasProps) {
  return (
    <Canvas
      linear
      flat
      dpr={[1, 1.75]}
      gl={{ antialias: true, powerPreference: "high-performance" }}
      camera={{ fov: FOV, near: 0.005, far: 2000, position: [1.4, 1.2, 1.4] }}
      role="img"
      aria-label="Reconstrucción 3D en vivo. Arrastra para girar, rueda o pellizca para acercar."
    >
      <SceneContent {...props} />
    </Canvas>
  );
}
