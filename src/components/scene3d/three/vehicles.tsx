"use client";
/**
 * Vehículos: caja con proporciones por tipo, orientada, volcada o de costado según su
 * estado; en llamas con fuego; posible atrapamiento con halo rojo pulsante.
 */
import { useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { yawForHeading } from "../geometry";
import type { NVehicle } from "../model";
import { vehicleCaption } from "../labels";
import { useIsSelected, usePick, useSceneCtx } from "./context";
import { Flames } from "./fire";
import { Chip, Label } from "./label";
import { seedOf, vehiclePose } from "./pose";

/** Carrocería por tipo: cuerpo bajo + cabina, o un solo volumen. */
function Body({ v, color, glass }: { v: NVehicle; color: string; glass: string }) {
  const { length: L, width: W, height: H } = v;
  switch (v.kind) {
    case "car":
    case "suv_pickup": {
      const low = H * 0.55;
      return (
        <>
          <mesh position-y={-H / 2 + low / 2}>
            <boxGeometry args={[W, low, L]} />
            <meshLambertMaterial color={color} />
          </mesh>
          <mesh position={[0, H / 2 - (H - low) / 2, v.kind === "car" ? -L * 0.05 : L * 0.1]}>
            <boxGeometry args={[W * 0.9, H - low, L * (v.kind === "car" ? 0.52 : 0.4)]} />
            <meshLambertMaterial color={glass} />
          </mesh>
        </>
      );
    }
    case "truck": {
      const cab = Math.min(2.4, L * 0.25);
      return (
        <>
          <mesh position={[0, -H * 0.1, L / 2 - cab / 2]}>
            <boxGeometry args={[W, H * 0.8, cab]} />
            <meshLambertMaterial color={glass} />
          </mesh>
          <mesh position={[0, 0, -cab / 2]}>
            <boxGeometry args={[W, H, L - cab - 0.2]} />
            <meshLambertMaterial color={color} />
          </mesh>
        </>
      );
    }
    default:
      return (
        <>
          <mesh>
            <boxGeometry args={[W, H, L]} />
            <meshLambertMaterial color={color} />
          </mesh>
          {/* Parabrisas: marca el frente */}
          <mesh position={[0, H * 0.18, L / 2 + 0.01]}>
            <planeGeometry args={[W * 0.86, H * 0.38]} />
            <meshBasicMaterial color={glass} />
          </mesh>
        </>
      );
  }
}

function EntrapmentHalo({ radius, color }: { radius: number; color: string }) {
  const { animate } = useSceneCtx();
  const ref = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    const m = ref.current;
    if (!m) return;
    const mat = m.material as THREE.MeshBasicMaterial;
    if (!animate) {
      mat.opacity = 0.7;
      return;
    }
    mat.opacity = 0.45 + 0.4 * (0.5 + 0.5 * Math.sin(state.clock.elapsedTime * 4.2));
  });
  return (
    <mesh ref={ref} rotation-x={-Math.PI / 2} position-y={0.12} renderOrder={25}>
      <ringGeometry args={[radius, radius + 0.45, 48]} />
      <meshBasicMaterial color={color} transparent opacity={0.7} depthTest={false} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  );
}

function Vehicle({ v }: { v: NVehicle }) {
  const { palette, labels, select } = useSceneCtx();
  const pick = usePick("vehicle", v.id);
  const selected = useIsSelected("vehicle", v.id);
  const pose = vehiclePose(v.state, v.width, v.height);
  const halo = Math.max(v.length, v.width) * 0.75 + 0.6;
  const caption = vehicleCaption(v);
  const color = v.burning ? palette.accent : selected ? palette.info : palette.lineStrong;
  const glass = v.burning ? palette.critical : palette.muted;
  const topY = (v.state === "on_side" ? v.width : v.height * pose.scaleY) + 0.3;
  return (
    <group position={[v.x, 0, -v.y]} rotation-y={yawForHeading(v.rotationDeg)}>
      <group {...pick}>
        <group position-y={pose.lift} rotation-z={pose.rollRad} scale-y={pose.scaleY}>
          <Body v={v} color={color} glass={glass} />
        </group>
      </group>
      {v.burning && <Flames position={[0, topY - 0.4, 0]} radius={Math.max(1.2, Math.min(3, v.width))} strong={false} light seed={seedOf(v.id)} />}
      {v.entrapment && <EntrapmentHalo radius={halo} color={palette.critical} />}
      {selected && (
        <mesh rotation-x={-Math.PI / 2} position-y={0.14} renderOrder={26}>
          <ringGeometry args={[halo + 0.7, halo + 1, 48]} />
          <meshBasicMaterial color={palette.info} transparent depthTest={false} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      )}
      {(labels || v.entrapment) && (
        <Label
          position={[0, topY + (v.burning ? 3.5 : 1), 0]}
          layer={v.entrapment ? "critical" : "base"}
          onActivate={() => select({ kind: "vehicle", id: v.id })}
          ariaLabel={`Vehículo: ${caption}${v.entrapment ? ", posible atrapamiento" : ""}`}
        >
          {v.entrapment ? (
            <Chip tone="critical" selected={selected} className="flex-col items-start gap-0">
              <span className="font-bold">Posible atrapamiento</span>
              <span className="text-[10.5px] font-semibold opacity-90">{caption}</span>
            </Chip>
          ) : (
            <Chip tone={v.burning ? "accent" : "text"} selected={selected}>
              {caption}
            </Chip>
          )}
        </Label>
      )}
    </group>
  );
}

export function Vehicles({ items }: { items: NVehicle[] }) {
  return (
    <group>
      {items.map((v) => (
        <Vehicle key={v.id} v={v} />
      ))}
    </group>
  );
}
