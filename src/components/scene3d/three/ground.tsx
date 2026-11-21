"use client";
/** Suelo con grilla de 10 m, anillos de 25/50 m y calles (bloqueadas con rayado). */
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { Line } from "@react-three/drei";
import type { XY } from "../geometry";
import type { NRoad } from "../model";
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

export function Ground({ size, center, focus }: { size: number; center: XY; focus: XY }) {
  const { palette, labels } = useSceneCtx();
  const grid = useMemo(() => {
    const g = new THREE.GridHelper(size, Math.max(1, Math.round(size / 10)), palette.lineStrong, palette.line);
    const m = g.material as THREE.LineBasicMaterial;
    m.transparent = true;
    m.opacity = 0.75;
    m.depthWrite = false;
    return g;
  }, [size, palette.lineStrong, palette.line]);
  useEffect(
    () => () => {
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
    },
    [grid],
  );
  const rings = useMemo(() => [25, 50].map((r) => ({ r, pts: circlePoints(r, focus.x, Y_RING, -focus.y, 96) })), [focus.x, focus.y]);

  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[center.x, Y_GROUND, -center.y]}>
        <planeGeometry args={[size, size]} />
        <meshLambertMaterial color={palette.surface} />
      </mesh>
      <primitive object={grid} position={[center.x, 0, -center.y]} />
      {rings.map(({ r, pts }) => (
        <group key={r}>
          <Line points={pts} color={palette.lineStrong} lineWidth={1.2} dashed dashSize={2.2} gapSize={2.2} transparent opacity={0.9} />
          {labels && (
            <Label position={[focus.x, Y_RING, -(focus.y + r)]} align="center">
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
    t.repeat.set(road.length / 3, Math.max(1, road.width / 3));
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
            <meshBasicMaterial map={hatch} transparent opacity={0.75} depthWrite={false} />
          </mesh>
        )}
      </group>
      {name && (labels || road.blocked) && (
        <Label position={[lp.x, 0.2, -lp.y]} align="center" layer={road.blocked ? "high" : "base"}>
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
