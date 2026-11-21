"use client";
/**
 * Estructuras por pisos: muros semitransparentes con contorno por rol, losas visibles,
 * techo plano o a dos aguas, fachada principal marcada (lado A) y etiqueta.
 */
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { yawForHeading } from "../geometry";
import type { NStructure } from "../model";
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
    case "involved":
      return { edge: p.accent, wall: p.accent, wallOpacity: 0.16, facadeOpacity: 0.3, edgeOpacity: 1 };
    case "exposure":
      return { edge: p.warning, wall: p.warning, wallOpacity: 0.08, facadeOpacity: 0.16, edgeOpacity: 0.65 };
    default:
      return { edge: p.lineStrong, wall: p.muted, wallOpacity: 0.07, facadeOpacity: 0.12, edgeOpacity: 0.9 };
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

function Structure({ s }: { s: NStructure }) {
  const { palette, labels, select } = useSceneCtx();
  const pick = usePick("structure", s.id);
  const selected = useIsSelected("structure", s.id);
  const st = roleStyle(s.role, palette);
  const edge = selected ? palette.info : st.edge;
  const H = s.height;
  const slabs = useMemo(() => Array.from({ length: s.floors + 1 }, (_, i) => i * s.floorHeight), [s.floors, s.floorHeight]);
  const dashed = s.confidence === "low";
  const top = H + s.roofHeight;
  const yaw = yawForHeading(s.rotationDeg);
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
          {/* Losas por piso (la última es el cielo del último piso) */}
          {slabs.map((y, i) => (
            <mesh key={i} position-y={Math.max(0.06, y)}>
              <boxGeometry args={[s.width - 0.04, i === 0 ? 0.12 : 0.16, s.depth - 0.04]} />
              <meshLambertMaterial
                color={i === slabs.length - 1 && s.roof !== "gable" ? st.wall : palette.surface2}
                transparent
                opacity={i === 0 ? 0.9 : i === slabs.length - 1 && s.roof !== "gable" ? 0.4 : 0.55}
                depthWrite={false}
              />
            </mesh>
          ))}
        </group>
        <BoxEdges w={s.width} h={H} d={s.depth} y={H / 2} color={edge} opacity={st.edgeOpacity} dashed={dashed} />
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
          <Label position={[0, 0.2, s.depth / 2 + 3.4]} align="center">
            <span className="font-display text-[12px] font-bold text-muted" style={HALO}>
              A
            </span>
          </Label>
        )}
      </group>
      {labels && (
        <Label
          position={[s.x, top + 1.2, -s.y]}
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

export function Structures({ items }: { items: NStructure[] }) {
  return (
    <group>
      {items.map((s) => (
        <Structure key={s.id} s={s} />
      ))}
    </group>
  );
}
