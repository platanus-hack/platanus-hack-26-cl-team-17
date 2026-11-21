"use client";
/** Peligros (ícono + zona translúcida), accesos (grifos, puertas, puesto de mando…) y anotaciones. */
import { useMemo } from "react";
import * as THREE from "three";
import { Line } from "@react-three/drei";
import type { NAccess, NAnnotation, NHazard } from "../model";
import { ACCESS_KIND_LABEL, HAZARD_KIND_LABEL, HAZARD_SEVERITY_LABEL } from "../labels";
import { ACCESS_ICON, ACCESS_TONE, HAZARD_ICON, HAZARD_TONE, type Tone } from "../icons";
import type { Palette } from "../palette";
import { useIsSelected, usePick, useSceneCtx } from "./context";
import { Chip, HALO, Label } from "./label";
import { circlePoints } from "./textures";

function toneHex(tone: Tone, p: Palette): string {
  switch (tone) {
    case "critical":
      return p.critical;
    case "warning":
      return p.warning;
    case "accent":
      return p.accent;
    case "info":
      return p.info;
    case "ok":
      return p.ok;
    case "drone":
      return p.drone;
    case "text":
      return p.text;
    default:
      return p.muted;
  }
}

/* ───────────────────────────── Peligros ───────────────────────────── */

function Hazard({ h }: { h: NHazard }) {
  const { palette, labels, select } = useSceneCtx();
  const pick = usePick("hazard", h.id);
  const selected = useIsSelected("hazard", h.id);
  const tone = HAZARD_TONE[h.severity];
  const color = toneHex(tone, palette);
  const Icon = HAZARD_ICON[h.kind];
  const ring = useMemo(() => circlePoints(h.radius, h.x, 0.14, -h.y, 72), [h.radius, h.x, h.y]);
  const iconY = Math.max(h.z, 0) + 1.6;
  return (
    <group>
      {/* Zona sugerida: domo translúcido (no intercepta clics) */}
      <mesh position={[h.x, 0, -h.y]} raycast={() => undefined}>
        <sphereGeometry args={[h.radius, 40, 14, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshBasicMaterial color={color} transparent opacity={h.severity === "high" ? 0.085 : 0.06} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <Line points={ring} color={selected ? palette.info : color} lineWidth={selected ? 2.2 : 1.4} dashed dashSize={1.6} gapSize={1.1} transparent opacity={0.85} />
      <group {...pick} position={[h.x, Math.max(h.z, 0), -h.y]}>
        <mesh position-y={0.5}>
          <octahedronGeometry args={[0.55]} />
          <meshBasicMaterial color={color} />
        </mesh>
      </group>
      {h.z > 0.8 && (
        <Line
          points={[
            [h.x, 0, -h.y],
            [h.x, h.z, -h.y],
          ]}
          color={color}
          lineWidth={1}
          dashed
          dashSize={0.4}
          gapSize={0.3}
        />
      )}
      <Label
        position={[h.x, iconY, -h.y]}
        layer={h.severity === "high" ? "high" : "base"}
        priority={h.severity === "high" ? 70 : h.severity === "medium" ? 56 : 44}
        pinned={selected}
        onActivate={() => select({ kind: "hazard", id: h.id })}
        ariaLabel={`Peligro: ${HAZARD_KIND_LABEL[h.kind]}, severidad ${HAZARD_SEVERITY_LABEL[h.severity]}`}
        title={HAZARD_KIND_LABEL[h.kind]}
      >
        <Chip tone={tone} selected={selected} className={tone === "critical" ? undefined : "bg-surface/95"}>
          <Icon className="size-3.5" strokeWidth={2.4} aria-hidden="true" />
          {labels && <span>{HAZARD_KIND_LABEL[h.kind]}</span>}
        </Chip>
      </Label>
    </group>
  );
}

export function Hazards({ items }: { items: NHazard[] }) {
  return (
    <group>
      {items.map((h) => (
        <Hazard key={h.id} h={h} />
      ))}
    </group>
  );
}

/* ───────────────────────────── Accesos ───────────────────────────── */

function Access({ a }: { a: NAccess }) {
  const { palette, labels, select } = useSceneCtx();
  const pick = usePick("access", a.id);
  const selected = useIsSelected("access", a.id);
  const tone = ACCESS_TONE[a.kind];
  const color = toneHex(tone, palette);
  const Icon = ACCESS_ICON[a.kind];
  const text = a.label || ACCESS_KIND_LABEL[a.kind];
  const tall = a.kind === "command_post" || a.kind === "staging";
  return (
    <group>
      <group {...pick} position={[a.x, 0, -a.y]}>
        <mesh position-y={0.11} rotation-x={-Math.PI / 2}>
          <circleGeometry args={[0.9, 24]} />
          <meshBasicMaterial color={selected ? palette.info : color} transparent opacity={0.85} />
        </mesh>
        <mesh position-y={tall ? 1.4 : 0.6}>
          <cylinderGeometry args={[0.12, 0.12, tall ? 2.8 : 1.2, 8]} />
          <meshBasicMaterial color={color} />
        </mesh>
        {tall && (
          <mesh position={[0.45, 2.45, 0]}>
            <boxGeometry args={[0.8, 0.55, 0.05]} />
            <meshBasicMaterial color={color} />
          </mesh>
        )}
      </group>
      <Label
        position={[a.x, tall ? 3.4 : 1.8, -a.y]}
        priority={a.kind === "command_post" ? 46 : a.kind === "hydrant" ? 45 : 34}
        pinned={selected}
        onActivate={() => select({ kind: "access", id: a.id })}
        ariaLabel={`${ACCESS_KIND_LABEL[a.kind]}${a.label ? `: ${a.label}` : ""}`}
        title={text}
      >
        <Chip tone={tone} selected={selected} className={tone === "critical" ? undefined : "bg-surface/95"}>
          <Icon className="size-3.5" strokeWidth={2.4} aria-hidden="true" />
          {labels && <span>{text}</span>}
        </Chip>
      </Label>
    </group>
  );
}

export function AccessPoints({ items }: { items: NAccess[] }) {
  return (
    <group>
      {items.map((a) => (
        <Access key={a.id} a={a} />
      ))}
    </group>
  );
}

/* ───────────────────────────── Anotaciones ───────────────────────────── */

export function Annotations({ items }: { items: NAnnotation[] }) {
  const { palette } = useSceneCtx();
  return (
    <group>
      {items.map((n) => (
        <group key={n.id} position={[n.x, n.z, -n.y]}>
          <mesh position-y={0.15}>
            <sphereGeometry args={[0.22, 10, 8]} />
            <meshBasicMaterial color={palette.text} />
          </mesh>
          <Label position={[0, 0.3, 0]} align="right" priority={20}>
            <span className="text-[11px] text-text italic" style={HALO}>
              {n.text}
            </span>
          </Label>
        </group>
      ))}
    </group>
  );
}
