"use client";
/**
 * Cámaras de los medios (frustum pequeño con etiqueta M<n> y miniatura; clic → abrir el
 * medio) y drones (traza, posición actual a su altura con rumbo y etiqueta D<n> + altura).
 */
import { useCallback, useEffect, useMemo } from "react";
import * as THREE from "three";
import { Line } from "@react-three/drei";
import { Video } from "lucide-react";
import { yawForHeading, type Vec3, type XY } from "../geometry";
import type { NCamera, NDrone } from "../model";
import { droneCaption } from "../labels";
import { useIsSelected, usePick, useSceneCtx } from "./context";
import { cx } from "../tones";
import { Chip, Label } from "./label";
import { cameraTiltDeg, frustumSegments } from "./pose";

const RAD = Math.PI / 180;

/* ───────────────────────────── Cámaras ───────────────────────────── */

function Frustum({ length, color, opacity }: { length: number; color: string; opacity: number }) {
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(frustumSegments(length), 3));
    return g;
  }, [length]);
  useEffect(() => () => geo.dispose(), [geo]);
  const hw = Math.tan((58 * RAD) / 2) * length;
  const hh = Math.tan((36 * RAD) / 2) * length;
  return (
    <group>
      <lineSegments geometry={geo}>
        <lineBasicMaterial color={color} transparent opacity={opacity} />
      </lineSegments>
      <mesh position-z={length}>
        <planeGeometry args={[hw * 2, hh * 2]} />
        <meshBasicMaterial color={color} transparent opacity={0.14} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

function MediaCamera({ c, focus }: { c: NCamera; focus: XY }) {
  const { palette, select, openMedia, compact } = useSceneCtx();
  const open = useCallback(() => openMedia?.(c.mediaRef), [openMedia, c.mediaRef]);
  const pick = usePick("camera", c.mediaRef, open);
  const selected = useIsSelected("camera", c.mediaRef);
  const color = selected ? palette.text : palette.info;
  const elevated = c.z > 6;
  const length = elevated ? 9 : 4.5;
  const tilt = cameraTiltDeg(c.z, Math.hypot(c.x - focus.x, c.y - focus.y)) * RAD;
  const pos: Vec3 = [c.x, c.z, -c.y];
  return (
    <group>
      <group position={pos}>
        <group {...pick}>
          {c.facingDeg !== null ? (
            <group rotation-y={yawForHeading(c.facingDeg)}>
              <group rotation-x={tilt}>
                <mesh position-z={-0.15}>
                  <boxGeometry args={[0.7, 0.45, 0.55]} />
                  <meshBasicMaterial color={color} />
                </mesh>
                <Frustum length={length} color={color} opacity={c.confidence === "low" ? 0.55 : 0.9} />
              </group>
            </group>
          ) : (
            <mesh>
              <sphereGeometry args={[0.45, 14, 10]} />
              <meshBasicMaterial color={color} />
            </mesh>
          )}
        </group>
      </group>
      {c.z > 3 && (
        <Line
          points={[
            [c.x, 0, -c.y],
            [c.x, c.z, -c.y],
          ]}
          color={palette.info}
          lineWidth={1}
          dashed
          dashSize={0.8}
          gapSize={0.6}
          transparent
          opacity={0.6}
        />
      )}
      <Label
        position={[c.x, c.z + 1.1, -c.y]}
        layer="high"
        priority={54}
        pinned={selected}
        onActivate={() => {
          select({ kind: "camera", id: c.mediaRef });
          open();
        }}
        ariaLabel={`Cámara del medio ${c.mediaRef}${openMedia ? ". Abrir medio" : ""}`}
        title={openMedia ? `Abrir ${c.mediaRef}` : c.mediaRef}
      >
        <span className="relative block">
          {c.posterUrl && !compact ? (
            // Miniatura del medio al pasar el cursor, enfocar o seleccionar (URL propia de /api/files).
            <span
              className={cx(
                "absolute bottom-full left-1/2 mb-1 -translate-x-1/2 overflow-hidden rounded border border-info/60 bg-surface shadow-[0_2px_8px_rgb(0_0_0/0.5)]",
                selected ? "block" : "hidden group-hover:block group-focus-visible:block",
              )}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={c.posterUrl} alt="" loading="lazy" draggable={false} className="block h-[54px] w-24 bg-surface-2 object-cover" />
            </span>
          ) : null}
          <Chip tone="info" selected={selected} className="bg-surface/95">
            <Video className="size-3.5" strokeWidth={2.4} aria-hidden="true" />
            <span className="font-mono text-[11.5px] font-bold">{c.mediaRef}</span>
          </Chip>
        </span>
      </Label>
    </group>
  );
}

export function MediaCameras({ items, focus }: { items: NCamera[]; focus: XY }) {
  return (
    <group>
      {items.map((c) => (
        <MediaCamera key={c.mediaRef} c={c} focus={focus} />
      ))}
    </group>
  );
}

/* ───────────────────────────── Drones ───────────────────────────── */

function DroneBody({ color }: { color: string }) {
  return (
    <group scale={1.5}>
      <mesh rotation-y={Math.PI / 4}>
        <boxGeometry args={[2.2, 0.1, 0.12]} />
        <meshBasicMaterial color={color} />
      </mesh>
      <mesh rotation-y={-Math.PI / 4}>
        <boxGeometry args={[2.2, 0.1, 0.12]} />
        <meshBasicMaterial color={color} />
      </mesh>
      <mesh>
        <boxGeometry args={[0.6, 0.25, 0.7]} />
        <meshBasicMaterial color={color} />
      </mesh>
      {[45, 135, 225, 315].map((deg) => (
        <mesh key={deg} position={[Math.cos(deg * RAD) * 0.78, 0.08, Math.sin(deg * RAD) * 0.78]}>
          <cylinderGeometry args={[0.36, 0.36, 0.03, 16]} />
          <meshBasicMaterial color={color} transparent opacity={0.55} />
        </mesh>
      ))}
      {/* Nariz: marca el rumbo */}
      <mesh position-z={0.75} rotation-x={Math.PI / 2}>
        <coneGeometry args={[0.2, 0.6, 10]} />
        <meshBasicMaterial color={color} />
      </mesh>
    </group>
  );
}

function Drone({ d }: { d: NDrone }) {
  const { palette, select } = useSceneCtx();
  const pick = usePick("drone", d.id);
  const selected = useIsSelected("drone", d.id);
  const color = d.active ? palette.drone : palette.muted;
  const track = useMemo<Vec3[]>(() => d.track.map((p) => [p.x, p.z, -p.y]), [d.track]);
  const ground = useMemo<Vec3[]>(() => d.track.map((p) => [p.x, 0.16, -p.y]), [d.track]);
  return (
    <group>
      {track.length > 1 && (
        <>
          <Line points={track} color={color} lineWidth={1.8} dashed dashSize={2.4} gapSize={1.6} transparent opacity={0.85} />
          <Line points={ground} color={color} lineWidth={1} transparent opacity={0.25} />
        </>
      )}
      <Line
        points={[
          [d.x, 0, -d.y],
          [d.x, d.z, -d.y],
        ]}
        color={color}
        lineWidth={1}
        dashed
        dashSize={1}
        gapSize={0.8}
        transparent
        opacity={0.6}
      />
      <mesh position={[d.x, 0.17, -d.y]} rotation-x={-Math.PI / 2}>
        <circleGeometry args={[1.1, 20]} />
        <meshBasicMaterial color={color} transparent opacity={0.3} depthWrite={false} />
      </mesh>
      <group {...pick} position={[d.x, d.z, -d.y]} rotation-y={yawForHeading(d.headingDeg)}>
        <DroneBody color={selected ? palette.text : color} />
      </group>
      <Label
        position={[d.x, d.z + 2.2, -d.y]}
        layer="high"
        priority={60}
        pinned={selected}
        onActivate={() => select({ kind: "drone", id: d.id })}
        ariaLabel={`Dron ${droneCaption(d)}`}
      >
        <Chip tone={d.active ? "drone" : "muted"} selected={selected} className="bg-surface/95">
          {droneCaption(d)}
        </Chip>
      </Label>
    </group>
  );
}

export function Drones({ items }: { items: NDrone[] }) {
  return (
    <group>
      {items.map((d) => (
        <Drone key={d.id} d={d} />
      ))}
    </group>
  );
}
