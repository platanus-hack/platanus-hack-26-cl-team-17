"use client";
/** Suelo punteado (lámina técnica), anillos de 25/50 m y calles lisas (bloqueadas con rayado). */
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { Line } from "@react-three/drei";
import type { XY } from "../geometry";
import type { NRoad } from "../model";
import { SCENE_BG, SCENE_DOT } from "../palette";
import { useIsSelected, usePick, useSceneCtx } from "./context";
import { Chip, HALO, Label } from "./label";
import { roadLabelPoint } from "./pose";
import { circlePoints, hatchTexture } from "./textures";

/* Alturas de las capas del suelo (separadas para evitar parpadeo de profundidad). */
const Y_GROUND = -0.06;
const Y_ROAD_EDGE = 0.03;
const Y_ROAD = 0.05;
const Y_HATCH = 0.08;
const Y_RING = 0.1;

/**
 * Puntos del suelo: hasta ~220 × 220 con un leve desorden fijo (semilla constante, no cambia
 * entre renders). Se desvanecen con la distancia al foco (descarte aleatorio): a lo lejos
 * se amontonan en pantalla y se ven como ruido.
 */
function stippleDots(size: number, center: XY, focus: XY): { positions: Float32Array; step: number } {
  const step = Math.max(1, size / 220);
  const n = Math.floor(size / step);
  const half = size / 2;
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const r0 = 50;
  const r1 = 170;
  const pos = new Float32Array((n + 1) * (n + 1) * 3);
  let k = 0;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      const x = center.x - half + i * step + (rnd() - 0.5) * step * 0.7;
      const y = center.y - half + j * step + (rnd() - 0.5) * step * 0.7;
      const d = Math.hypot(x - focus.x, y - focus.y);
      if (rnd() > 1 - (d - r0) / (r1 - r0)) continue;
      pos[k++] = x;
      pos[k++] = 0.01;
      pos[k++] = -y;
    }
  }
  return { positions: pos.slice(0, k), step };
}

export function Ground({ size, center, focus }: { size: number; center: XY; focus: XY }) {
  const { palette, labels } = useSceneCtx();
  const dots = useMemo(() => {
    const { positions, step } = stippleDots(size, center, focus);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({ color: SCENE_DOT, size: step * 0.32, transparent: true, opacity: 0.6, depthWrite: false });
    return { geometry, material };
  }, [size, center, focus]);
  useEffect(
    () => () => {
      dots.geometry.dispose();
      dots.material.dispose();
    },
    [dots],
  );
  const rings = useMemo(() => [25, 50].map((r) => ({ r, pts: circlePoints(r, focus.x, Y_RING, -focus.y, 96) })), [focus.x, focus.y]);

  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[center.x, Y_GROUND, -center.y]}>
        <planeGeometry args={[size, size]} />
        <meshBasicMaterial color={SCENE_BG} />
      </mesh>
      <points geometry={dots.geometry} material={dots.material} />
      {rings.map(({ r, pts }) => (
        <group key={r}>
          <Line points={pts} color={palette.faint} lineWidth={1} dashed dashSize={1.6} gapSize={2.4} transparent opacity={0.7} />
          {labels && (
            <Label position={[focus.x, Y_RING, -(focus.y + r)]} align="center" priority={8}>
              <span className="font-mono text-[10px] text-faint" style={HALO}>
                {r} m
              </span>
            </Label>
          )}
        </group>
      ))}
    </group>
  );
}

function RoadMesh({ road, focus }: { road: NRoad; focus: XY }) {
  const { palette, labels } = useSceneCtx();
  const pick = usePick("road", road.id);
  const selected = useIsSelected("road", road.id);
  const dx = road.x2 - road.x1;
  const dy = road.y2 - road.y1;
  const yaw = Math.atan2(dy, dx);
  const mx = (road.x1 + road.x2) / 2;
  const my = (road.y1 + road.y2) / 2;
  const hatch = useMemo(() => {
    if (!road.blocked) return null;
    const t = hatchTexture(palette.warning).clone();
    t.repeat.set(road.length / 4, Math.max(1, road.width / 4));
    t.needsUpdate = true;
    return t;
  }, [road.blocked, road.length, road.width, palette.warning]);
  useEffect(() => () => hatch?.dispose(), [hatch]);
  const name = road.name || (road.blocked ? "Vía" : "");
  const lp = roadLabelPoint(road, focus);
  return (
    <group>
      <group {...pick} position={[mx, 0, -my]} rotation-y={yaw}>
        <mesh rotation-x={-Math.PI / 2} position-y={Y_ROAD_EDGE}>
          <planeGeometry args={[road.length, road.width + 0.8]} />
          <meshBasicMaterial color={selected ? palette.info : palette.lineStrong} />
        </mesh>
        <mesh rotation-x={-Math.PI / 2} position-y={Y_ROAD}>
          <planeGeometry args={[road.length, road.width]} />
          <meshLambertMaterial color={palette.surface2} />
        </mesh>
        {hatch && (
          <mesh rotation-x={-Math.PI / 2} position-y={Y_HATCH}>
            <planeGeometry args={[road.length, road.width]} />
            <meshBasicMaterial map={hatch} transparent opacity={0.3} depthWrite={false} />
          </mesh>
        )}
      </group>
      {name && (labels || road.blocked) && (
        <Label position={[lp.x, 0.2, -lp.y]} align="center" layer={road.blocked ? "high" : "base"} priority={road.blocked ? 58 : 24} pinned={selected}>
          {road.blocked ? (
            <Chip tone="warning">{name} · bloqueada</Chip>
          ) : (
            <span className="text-[11px] font-medium text-muted" style={HALO}>
              {name}
            </span>
          )}
        </Label>
      )}
    </group>
  );
}

export function Roads({ roads, focus }: { roads: NRoad[]; focus: XY }) {
  return (
    <group>
      {roads.map((r) => (
        <RoadMesh key={r.id} road={r} focus={focus} />
      ))}
    </group>
  );
}
