"use client";
/**
 * Entorno real (OSM): edificios del barrio como volúmenes fantasma muy tenues y calles
 * como líneas finas en el suelo. Una sola malla fusionada; no recibe eventos de puntero,
 * no proyecta sombras ni tiene etiquetas: lo inferido por la IA siempre manda.
 */
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { buildSurroundingsMesh, roadPositions, type EnvBuilding } from "../surroundings";
import { useSceneCtx } from "./context";

/* Bajo las calles inferidas (0,03–0,05) y sobre el suelo punteado. */
const Y_OSM_ROAD = 0.02;
const noRaycast = () => {};

export function SurroundingsLayer({ buildings, roadSegments }: { buildings: readonly EnvBuilding[]; roadSegments: readonly number[] }) {
  const { palette } = useSceneCtx();
  const geo = useMemo(() => {
    const m = buildSurroundingsMesh(buildings);
    const body = new THREE.BufferGeometry();
    body.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
    body.computeVertexNormals();
    const edges = new THREE.BufferGeometry();
    edges.setAttribute("position", new THREE.BufferAttribute(m.edges, 3));
    const roads = new THREE.BufferGeometry();
    roads.setAttribute("position", new THREE.BufferAttribute(roadPositions(roadSegments, Y_OSM_ROAD), 3));
    return { body, edges, roads };
  }, [buildings, roadSegments]);
  useEffect(
    () => () => {
      geo.body.dispose();
      geo.edges.dispose();
      geo.roads.dispose();
    },
    [geo],
  );
  if (buildings.length === 0 && roadSegments.length === 0) return null;
  return (
    <group renderOrder={-1}>
      <mesh geometry={geo.body} raycast={noRaycast} renderOrder={-1}>
        <meshLambertMaterial color={palette.faint} transparent opacity={0.16} depthWrite={false} />
      </mesh>
      <lineSegments geometry={geo.edges} raycast={noRaycast} renderOrder={-1}>
        <lineBasicMaterial color={palette.faint} transparent opacity={0.28} depthWrite={false} />
      </lineSegments>
      <lineSegments geometry={geo.roads} raycast={noRaycast} renderOrder={-1}>
        <lineBasicMaterial color={palette.faint} transparent opacity={0.45} depthWrite={false} />
      </lineSegments>
    </group>
  );
}
