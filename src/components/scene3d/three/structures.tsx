"use client";
/**
 * Estructuras por pisos: muros semitransparentes con contorno por rol, losas visibles,
 * techo plano o a dos aguas, fachada principal marcada (lado A) y etiqueta.
 */
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { localToWorld, yawForHeading } from "../geometry";
import { footprintOf, type NFire, type NStructure } from "../model";
import { structureCaption, structureTitle } from "../labels";
import type { Palette } from "../palette";
import { useIsSelected, usePick, useSceneCtx } from "./context";
import { Chip, HALO, Label } from "./label";
import { gableRoofEdges, gableRoofPositions } from "./pose";

interface RoleStyle {
  edge: string;
  wall: string;
  wallOpacity: number;
  facadeOpacity: number;
  edgeOpacity: number;
}

function roleStyle(role: NStructure["role"], p: Palette): RoleStyle {
  switch (role) {
    // Maqueta blanca: muros claros semitransparentes (se ve lo que hay adentro); el rol se lee en el contorno.
    case "involved":
      return { edge: p.accent, wall: p.surface, wallOpacity: 0.42, facadeOpacity: 0.5, edgeOpacity: 1 };
    case "exposure":
      return { edge: p.warning, wall: p.surface, wallOpacity: 0.38, facadeOpacity: 0.45, edgeOpacity: 0.8 };
    default:
      return { edge: p.faint, wall: p.surface, wallOpacity: 0.34, facadeOpacity: 0.4, edgeOpacity: 0.9 };
  }
}

/** Contorno de caja (12 aristas) como segmentos; con trazo discontinuo si la confianza es baja. */
function BoxEdges({ w, h, d, y, color, opacity, dashed }: { w: number; h: number; d: number; y: number; color: string; opacity: number; dashed: boolean }) {
  const geo = useMemo(() => {
    const box = new THREE.BoxGeometry(w, h, d);
    const e = new THREE.EdgesGeometry(box);
    box.dispose();
    return e;
  }, [w, h, d]);
  useEffect(() => () => geo.dispose(), [geo]);
  return (
    <lineSegments
      geometry={geo}
      position-y={y}
      ref={(l) => {
        if (l && dashed) l.computeLineDistances();
      }}
    >
      {dashed ? (
        <lineDashedMaterial color={color} transparent opacity={opacity} dashSize={0.7} gapSize={0.45} />
      ) : (
        <lineBasicMaterial color={color} transparent opacity={opacity} />
      )}
    </lineSegments>
  );
}

/** Contornos horizontales en cada entrepiso (se lee la cantidad de pisos sin tapar el interior). */
function FloorLines({ w, d, levels, color, opacity }: { w: number; d: number; levels: number[]; color: string; opacity: number }) {
  const geo = useMemo(() => {
    const x = w / 2;
    const z = d / 2;
    const pts: number[] = [];
    for (const y of levels) {
      pts.push(-x, y, z, x, y, z, x, y, z, x, y, -z, x, y, -z, -x, y, -z, -x, y, -z, -x, y, z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pts), 3));
    return g;
  }, [w, d, levels]);
  useEffect(() => () => geo.dispose(), [geo]);
  return (
    <lineSegments geometry={geo}>
      <lineBasicMaterial color={color} transparent opacity={opacity} />
    </lineSegments>
  );
}

function GableRoof({ w, d, h, y, color, edge, opacity, edgeOpacity }: { w: number; d: number; h: number; y: number; color: string; edge: string; opacity: number; edgeOpacity: number }) {
  const [geo, edges] = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(gableRoofPositions(w, d, h), 3));
    g.computeVertexNormals();
    const e = new THREE.BufferGeometry();
    e.setAttribute("position", new THREE.BufferAttribute(gableRoofEdges(w, d, h), 3));
    return [g, e] as const;
  }, [w, d, h]);
  useEffect(
    () => () => {
      geo.dispose();
      edges.dispose();
    },
    [geo, edges],
  );
  return (
    <group position-y={y}>
      <mesh geometry={geo}>
        <meshLambertMaterial color={color} transparent opacity={opacity} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <lineSegments geometry={edges}>
        <lineBasicMaterial color={edge} transparent opacity={edgeOpacity} />
      </lineSegments>
    </group>
  );
}

/** Flecha en el suelo frente a la fachada principal (lado A). */
function FacadeArrow({ d, color }: { d: number; color: string }) {
  const shape = useMemo(() => {
    const s = new THREE.Shape();
    s.moveTo(-1, 0);
    s.lineTo(1, 0);
    s.lineTo(0, 1.8);
    s.closePath();
    return s;
  }, []);
  return (
    <mesh rotation-x={Math.PI / 2} position={[0, 0.12, d / 2 + 0.8]}>
      <shapeGeometry args={[shape]} />
      <meshBasicMaterial color={color} transparent opacity={0.85} side={THREE.DoubleSide} depthWrite={false} />
    </mesh>
  );
}

function Structure({ s, fireFloors }: { s: NStructure; fireFloors: readonly number[] }) {
  const { palette, labels, select } = useSceneCtx();
  const pick = usePick("structure", s.id);
  const selected = useIsSelected("structure", s.id);
  const st = roleStyle(s.role, palette);
  const edge = selected ? palette.info : st.edge;
  const H = s.height;
  const slabs = useMemo(() => Array.from({ length: s.floors + 1 }, (_, i) => i * s.floorHeight), [s.floors, s.floorHeight]);
  const between = useMemo(() => slabs.slice(1, -1), [slabs]);
  // Losas rellenas solo en estructuras afectadas o expuestas; en las de referencia bastan los contornos.
  const solidSlabs = s.role !== "reference";
  const dashed = s.confidence === "low";
  const top = H + s.roofHeight;
  const yaw = yawForHeading(s.rotationDeg);
  const labelAt = localToWorld(footprintOf(s), 0, -s.depth / 2);
  return (
    <group>
      <group position={[s.x, 0, -s.y]} rotation-y={yaw}>
        <group {...pick}>
          {/* Muros */}
          <mesh position-y={H / 2}>
            <boxGeometry args={[s.width, H, s.depth]} />
            <meshLambertMaterial color={st.wall} transparent opacity={selected ? st.wallOpacity + 0.1 : st.wallOpacity} depthWrite={false} />
          </mesh>
          {/* Fachada principal más marcada */}
          <mesh position={[0, H / 2, s.depth / 2 + 0.02]}>
            <planeGeometry args={[s.width, H]} />
            <meshLambertMaterial color={st.wall} transparent opacity={st.facadeOpacity} depthWrite={false} side={THREE.DoubleSide} />
          </mesh>
          {/* Losas por piso (la última es el cielo del último piso); el piso con fuego va teñido */}
          {slabs.map((y, i) => {
            const last = i === slabs.length - 1;
            if (!solidSlabs && i !== 0 && !(last && s.roof !== "gable")) return null;
            const burning = fireFloors.includes(i + 1) && !last;
            return (
              <mesh key={i} position-y={Math.max(0.06, y)}>
                <boxGeometry args={[s.width - 0.04, i === 0 ? 0.12 : 0.16, s.depth - 0.04]} />
                <meshLambertMaterial
                  color={burning ? palette.accent : last && s.roof !== "gable" ? st.wall : palette.surface2}
                  transparent
                  opacity={i === 0 ? 0.9 : burning ? 0.45 : last && s.roof !== "gable" ? 0.35 : 0.3}
                  depthWrite={false}
                />
              </mesh>
            );
          })}
        </group>
        <BoxEdges w={s.width} h={H} d={s.depth} y={H / 2} color={edge} opacity={st.edgeOpacity} dashed={dashed} />
        {between.length > 0 && <FloorLines w={s.width} d={s.depth} levels={between} color={edge} opacity={st.edgeOpacity * 0.55} />}
        {s.roof === "gable" && s.roofHeight > 0 && (
          <GableRoof w={s.width + 0.4} d={s.depth + 0.4} h={s.roofHeight} y={H} color={st.wall} edge={edge} opacity={st.wallOpacity + 0.14} edgeOpacity={st.edgeOpacity} />
        )}
        {/* Zócalo de la fachada principal */}
        <mesh position={[0, 0.2, s.depth / 2 + 0.04]}>
          <boxGeometry args={[s.width, 0.4, 0.08]} />
          <meshBasicMaterial color={selected ? palette.info : palette.text} transparent opacity={0.9} />
        </mesh>
        <FacadeArrow d={s.depth} color={palette.text} />
        {labels && (
          <Label position={[0, 0.2, s.depth / 2 + 3.4]} align="center" priority={12}>
            <span className="font-display text-[12px] font-bold text-muted" style={HALO}>
              A
            </span>
          </Label>
        )}
      </group>
      {labels && (
        <Label
          position={[labelAt.x, top + 1, -labelAt.y]}
          priority={s.role === "involved" ? 68 : s.role === "exposure" ? 50 : 38}
          pinned={selected}
          onActivate={() => select({ kind: "structure", id: s.id })}
          ariaLabel={`Estructura: ${structureTitle(s)}, ${structureCaption(s)}`}
        >
          <StructureTag s={s} selected={selected} />
        </Label>
      )}
    </group>
  );
}

function StructureTag({ s, selected }: { s: NStructure; selected: boolean }) {
  const tone = s.role === "involved" ? "accent" : s.role === "exposure" ? "warning" : "muted";
  return (
    <Chip tone={tone} selected={selected} className="flex-col items-start gap-0">
      <span className="text-text">{structureTitle(s)}</span>
      <span className="font-medium">{structureCaption(s)}</span>
    </Chip>
  );
}

const NO_FLOORS: readonly number[] = [];

export function Structures({ items, fires }: { items: NStructure[]; fires: NFire[] }) {
  const byStructure = useMemo(() => {
    const m = new Map<string, number[]>();
    for (const f of fires) {
      if (!f.structureId || f.floor < 1 || f.intensity === "smoke_only") continue;
      const list = m.get(f.structureId) ?? [];
      if (!list.includes(f.floor)) list.push(f.floor);
      m.set(f.structureId, list);
    }
    return m;
  }, [fires]);
  return (
    <group>
      {items.map((s) => (
        <Structure key={s.id} s={s} fireFloors={byStructure.get(s.id) ?? NO_FLOORS} />
      ))}
    </group>
  );
}
