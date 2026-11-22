"use client";
/**
 * Lienzo de los Gaussian splats en vivo (three.js + Spark). Se carga solo en el navegador con
 * next/dynamic desde Live3D.tsx, igual que el de la nube de puntos.
 *
 * Las gaussianas vienen en el sistema del mundo del servicio; la matriz `display` (mundo → vista)
 * va en el propio SplatMesh, y la trayectoria del dron en un <group> con la misma matriz. Cada
 * instantánea nueva arma un SplatMesh aparte y reemplaza al anterior recién cuando está listo:
 * no hay parpadeo mientras se actualiza.
 *
 * Colores: a diferencia del lienzo de puntos, aquí la salida es sRGB (Spark entrega los colores
 * del video tal cual solo con salida sRGB) y Spark pide el renderer sin antialias.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { SparkRenderer, SplatFileType, SplatMesh } from "@sparkjsdev/spark";
import type { Live3DStatus } from "@/lib/drone/live3d-types";
import type { LiveSplat } from "@/lib/drone/live3d-splat";
import { robustBounds, type PointCloudBuffer } from "@/lib/drone/live3d-points";
import { AutoFrame, BG, FOV, Trajectory } from "./Live3DCanvas";

export interface Live3DSplatCanvasProps {
  status: Live3DStatus;
  /** La nube de puntos (ya bajada) solo sirve para encuadrar. */
  cloud: PointCloudBuffer;
  cloudVersion: number;
  splat: LiveSplat | null;
}

function applyDisplay(obj: THREE.Object3D, d: readonly number[]) {
  const m = new THREE.Matrix4().set(d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7], d[8], d[9], d[10], d[11], d[12], d[13], d[14], d[15]);
  m.decompose(obj.position, obj.quaternion, obj.scale);
  obj.updateMatrixWorld(true);
}

function Splats({ splat, display }: { splat: LiveSplat | null; display: number[] }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const current = useRef<SplatMesh | null>(null);
  const displayRef = useRef(display);

  useEffect(() => {
    const spark = new SparkRenderer({ renderer: gl });
    scene.add(spark);
    return () => {
      scene.remove(spark);
      spark.dispose();
    };
  }, [gl, scene]);

  useEffect(() => {
    displayRef.current = display;
    if (current.current) applyDisplay(current.current, display);
  }, [display]);

  useEffect(() => {
    if (!splat || splat.count === 0) return;
    let cancelled = false;
    // Copia: Spark puede quedarse con el buffer (lo pasa a su worker) y el estado lo conserva.
    const mesh = new SplatMesh({ fileBytes: splat.splatBytes.slice(), fileType: SplatFileType.SPLAT });
    mesh.initialized
      .then(() => {
        if (cancelled) {
          mesh.dispose();
          return;
        }
        applyDisplay(mesh, displayRef.current);
        scene.add(mesh);
        const old = current.current;
        current.current = mesh;
        if (old) {
          scene.remove(old);
          old.dispose();
        }
      })
      .catch((err: unknown) => {
        console.warn("[live3d] no se pudo armar la instantánea de splats", err);
        mesh.dispose();
      });
    return () => {
      cancelled = true;
    };
  }, [splat, scene]);

  useEffect(
    () => () => {
      const m = current.current;
      current.current = null;
      if (m) {
        m.parent?.remove(m);
        m.dispose();
      }
    },
    [],
  );
  return null;
}

function SceneContent({ status, cloud, splat }: Live3DSplatCanvasProps) {
  const groupRef = useRef<THREE.Group>(null);
  const [interacted, setInteracted] = useState(false);
  const display = status.display;
  const bg = useMemo(() => new THREE.Color().setRGB(BG[0], BG[1], BG[2], THREE.SRGBColorSpace), []);

  useLayoutEffect(() => {
    const g = groupRef.current;
    if (!g) return;
    const d = display;
    g.matrix.set(d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7], d[8], d[9], d[10], d[11], d[12], d[13], d[14], d[15]);
    g.matrixWorldNeedsUpdate = true;
  }, [display]);

  // Encuadre con la muestra de la nube (se muta en su lugar; cambia cuando cambia la cantidad).
  const count = cloud.count;
  const bounds = useMemo(() => (count > 0 ? robustBounds(cloud.samples, display) : null), [cloud, count, display]);
  const radius = bounds?.radius ?? 1;

  return (
    <>
      <primitive object={bg} attach="background" />
      <Splats splat={splat} display={display} />
      <group ref={groupRef} matrixAutoUpdate={false}>
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

export default function Live3DSplatCanvas(props: Live3DSplatCanvasProps) {
  return (
    <Canvas
      flat
      dpr={[1, 1.5]}
      gl={{ antialias: false, powerPreference: "high-performance" }}
      camera={{ fov: FOV, near: 0.005, far: 2000, position: [1.4, 1.2, 1.4] }}
      role="img"
      aria-label="Gaussian splats en vivo. Arrastra para girar, rueda o pellizca para acercar."
    >
      <SceneContent {...props} />
    </Canvas>
  );
}
