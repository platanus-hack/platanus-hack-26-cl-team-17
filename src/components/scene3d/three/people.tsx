"use client";
/**
 * Personas: marcador vertical muy visible. Las que están en riesgo (atrapadas, en ventana,
 * en el techo) van en rojo, con pulso, por encima de muros y humo, y siempre rotuladas.
 */
import { useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import type { NPerson } from "../model";
import { CONFIDENCE_LABEL, personCaption } from "../labels";
import { useIsSelected, usePick, useSceneCtx } from "./context";
import { Chip, Label } from "./label";

const BEACON = { critical: 5.5, injured: 2.6, other: 0 } as const;

function Pulse({ color }: { color: string }) {
  const { animate } = useSceneCtx();
  const ref = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    const m = ref.current;
    if (!m) return;
    const mat = m.material as THREE.MeshBasicMaterial;
    if (!animate) {
      m.scale.setScalar(1.8);
      mat.opacity = 0.6;
      return;
    }
    const t = (state.clock.elapsedTime % 1.6) / 1.6;
    m.scale.setScalar(1 + t * 2.4);
    mat.opacity = 0.85 * (1 - t);
  });
  return (
    <mesh ref={ref} rotation-x={-Math.PI / 2} position-y={0.08} renderOrder={30}>
      <ringGeometry args={[0.9, 1.15, 40]} />
      <meshBasicMaterial color={color} transparent opacity={0.6} depthTest={false} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  );
}

function Person({ p }: { p: NPerson }) {
  const { palette, labels, select } = useSceneCtx();
  const pick = usePick("person", p.id);
  const selected = useIsSelected("person", p.id);
  const critical = p.risk === "critical";
  const injured = p.risk === "injured";
  const color = critical ? palette.critical : injured ? palette.warning : palette.muted;
  const beacon = BEACON[p.risk];
  const bodyScale = critical || injured ? 1 : 0.8;
  const pinY = 1.75 + beacon;
  const caption = personCaption(p);
  // En riesgo: se dibujan sobre todo lo demás (prioridad visual).
  const onTop = critical;
  return (
    <group position={[p.x, p.z, -p.y]}>
      <group {...pick}>
        <mesh position-y={0.8 * bodyScale} scale={bodyScale} renderOrder={onTop ? 31 : 0}>
          <capsuleGeometry args={[0.32, 0.95, 4, 10]} />
          <meshBasicMaterial color={color} depthTest={!onTop} transparent={onTop} />
        </mesh>
        {beacon > 0 && (
          <>
            <mesh position-y={1.7 + beacon / 2} renderOrder={onTop ? 31 : 0}>
              <cylinderGeometry args={[0.07, 0.07, beacon, 6]} />
              <meshBasicMaterial color={color} depthTest={!onTop} transparent={onTop} />
            </mesh>
            <mesh position-y={pinY + (critical ? 0.7 : 0.5)} rotation-x={Math.PI} renderOrder={onTop ? 32 : 0}>
              <coneGeometry args={[critical ? 0.85 : 0.6, critical ? 1.4 : 1, 16]} />
              <meshBasicMaterial color={color} depthTest={!onTop} transparent={onTop} />
            </mesh>
          </>
        )}
      </group>
      {critical && <Pulse color={palette.critical} />}
      {selected && (
        <mesh rotation-x={-Math.PI / 2} position-y={0.1} renderOrder={33}>
          <ringGeometry args={[1.5, 1.8, 40]} />
          <meshBasicMaterial color={palette.info} transparent depthTest={false} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      )}
      {(critical || labels) && (
        <Label
          position={[0, beacon > 0 ? pinY + (critical ? 1.5 : 1.1) : 2, 0]}
          layer={critical ? "critical" : injured ? "high" : "base"}
          priority={critical ? 100 : injured ? 62 : 36}
          pinned={critical || selected}
          onActivate={() => select({ kind: "person", id: p.id })}
          ariaLabel={`${caption}, confianza ${CONFIDENCE_LABEL[p.confidence]}`}
        >
          {critical ? (
            <Chip tone="critical" selected={selected} className="flex-col items-start gap-0 px-2 py-1 text-[12px] motion-safe:animate-pulse-critical">
              <span className="font-bold">{caption}</span>
              <span className="text-[10.5px] font-semibold opacity-90">confianza {CONFIDENCE_LABEL[p.confidence]}</span>
            </Chip>
          ) : (
            <Chip tone={injured ? "warning" : "muted"} selected={selected}>
              {caption}
            </Chip>
          )}
        </Label>
      )}
    </group>
  );
}

export function People({ items }: { items: NPerson[] }) {
  // Las personas en riesgo se dibujan al final (encima).
  const sorted = [...items].sort((a, b) => (a.risk === "critical" ? 1 : 0) - (b.risk === "critical" ? 1 : 0));
  return (
    <group>
      {sorted.map((p) => (
        <Person key={p.id} p={p} />
      ))}
    </group>
  );
}
