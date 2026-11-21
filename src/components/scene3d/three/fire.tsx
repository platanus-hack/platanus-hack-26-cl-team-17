"use client";
/**
 * Focos de fuego (lenguas emisivas + resplandor + luz, animación barata), bruma de
 * "solo humo" y columnas de humo con deriva (partículas animadas en la GPU).
 */
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { CONFIDENCE_LABEL, fireCaption } from "../labels";
import { headingToThree, type Vec3 } from "../geometry";
import type { NFire, NSmoke } from "../model";
import { SMOKE_HEX } from "../palette";
import { useIsSelected, usePick, useSceneCtx } from "./context";
import { Chip, Label } from "./label";
import { rand, seedOf, smokeConfig } from "./pose";
import { flameGeometry, glowTexture } from "./textures";

/* ───────────────────────────── Fuego ───────────────────────────── */

interface Tongue {
  x: number;
  z: number;
  r: number;
  h: number;
  phase: number;
}

/**
 * Llamas de un foco (también se usa en vehículos en llamas). `position` es la base de las
 * llamas; `radius` su extensión horizontal.
 */
export function Flames({ position, radius, strong, light, seed }: { position: Vec3; radius: number; strong: boolean; light: boolean; seed: number }) {
  const { palette, animate } = useSceneCtx();
  const group = useRef<THREE.Group>(null);
  const glowRef = useRef<THREE.Sprite>(null);
  const n = strong ? 6 : 4;
  const tongues = useMemo<Tongue[]>(
    () =>
      Array.from({ length: n }, (_, i) => {
        const a = rand(i, seed) * Math.PI * 2;
        const d = i === 0 ? 0 : rand(i, seed + 1) * radius * 0.55;
        return {
          x: Math.cos(a) * d,
          z: Math.sin(a) * d,
          r: radius * (i === 0 ? 0.45 : 0.22 + rand(i, seed + 2) * 0.16),
          h: radius * (i === 0 ? 1.7 : 0.9 + rand(i, seed + 3) * 0.8) * (strong ? 1.15 : 1),
          phase: rand(i, seed + 4) * Math.PI * 2,
        };
      }),
    [n, radius, seed, strong],
  );
  useFrame((state) => {
    if (!animate) return;
    const t = state.clock.elapsedTime;
    const g = group.current;
    if (g) {
      g.children.forEach((m, i) => {
        const tg = tongues[i];
        if (!tg) return;
        const k = 0.78 + 0.22 * Math.sin(t * 7.3 + tg.phase) + 0.1 * Math.sin(t * 13.1 + tg.phase * 1.7);
        m.scale.set(tg.r * (1.05 - 0.1 * k), tg.h * k, tg.r * (1.05 - 0.1 * k));
      });
    }
    const s = glowRef.current;
    if (s) {
      const k = radius * (strong ? 3.6 : 3) * (0.93 + 0.07 * Math.sin(t * 9.1 + seed));
      s.scale.set(k, k, 1);
    }
  });
  const glow = radius * (strong ? 3.6 : 3);
  return (
    <group position={position}>
      <group ref={group}>
        {tongues.map((tg, i) => (
          <mesh key={i} geometry={flameGeometry()} position={[tg.x, 0, tg.z]} scale={[tg.r, tg.h, tg.r]}>
            <meshBasicMaterial
              color={i === 0 ? palette.warning : i % 2 ? palette.accent : palette.critical}
              transparent
              opacity={i === 0 ? 0.95 : 0.85}
              depthWrite={false}
              side={THREE.DoubleSide}
            />
          </mesh>
        ))}
      </group>
      <sprite ref={glowRef} position-y={radius * 0.7} scale={[glow, glow, 1]} raycast={() => undefined}>
        <spriteMaterial map={glowTexture()} color={palette.accent} blending={THREE.AdditiveBlending} transparent depthWrite={false} opacity={0.8} />
      </sprite>
      {light && <pointLight position-y={radius * 0.8} color={palette.warning} intensity={strong ? 60 : 30} distance={radius * 9} decay={1.6} />}
    </group>
  );
}

/** Bruma de "solo humo" (sin llama visible). */
function Haze({ position, radius }: { position: Vec3; radius: number }) {
  const { palette, animate } = useSceneCtx();
  const ref = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    if (!animate || !ref.current) return;
    const k = radius * 1.3 * (1 + 0.06 * Math.sin(state.clock.elapsedTime * 1.4));
    ref.current.scale.setScalar(k);
  });
  return (
    <mesh ref={ref} position={position} scale={radius * 1.3}>
      <sphereGeometry args={[1, 20, 14]} />
      <meshBasicMaterial color={palette.muted} transparent opacity={0.22} depthWrite={false} />
    </mesh>
  );
}

function FireZone({ f, lightIndex }: { f: NFire; lightIndex: number }) {
  const { palette, labels, select } = useSceneCtx();
  const pick = usePick("fire", f.id);
  const selected = useIsSelected("fire", f.id);
  const seed = useMemo(() => seedOf(f.id), [f.id]);
  const smokeOnly = f.intensity === "smoke_only";
  const base: Vec3 = [f.x, Math.max(0, f.z - f.radius * 0.5), -f.y];
  const center: Vec3 = [f.x, f.z, -f.y];
  const tone = f.intensity === "heavy" ? "critical" : smokeOnly ? "muted" : "accent";
  return (
    <group>
      <group {...pick}>
        {smokeOnly ? (
          <Haze position={center} radius={f.radius} />
        ) : (
          <Flames position={base} radius={f.radius} strong={f.intensity === "heavy"} light={lightIndex < 4} seed={seed} />
        )}
      </group>
      {selected && (
        <mesh position={center} renderOrder={20}>
          <sphereGeometry args={[f.radius * 1.5, 24, 16]} />
          <meshBasicMaterial color={palette.info} wireframe transparent opacity={0.5} depthTest={false} />
        </mesh>
      )}
      {labels && (
        <Label
          position={[f.x, f.z + f.radius * (smokeOnly ? 1.5 : 1.9), -f.y]}
          onActivate={() => select({ kind: "fire", id: f.id })}
          ariaLabel={`${fireCaption(f)}, confianza ${CONFIDENCE_LABEL[f.confidence]}`}
        >
          <Chip tone={tone} selected={selected}>
            {fireCaption(f)}
          </Chip>
        </Label>
      )}
    </group>
  );
}

/** Índice de luz de cada foco con llama (solo los primeros llevan luz propia). */
function lightIndexes(items: NFire[]): number[] {
  const out: number[] = [];
  let n = 0;
  for (const f of items) out.push(f.intensity === "smoke_only" ? Number.POSITIVE_INFINITY : n++);
  return out;
}

export function Fires({ items }: { items: NFire[] }) {
  const idx = lightIndexes(items);
  return (
    <group>
      {items.map((f, i) => (
        <FireZone key={f.id} f={f} lightIndex={idx[i]} />
      ))}
    </group>
  );
}

/* ───────────────────────────── Humo ───────────────────────────── */

const SMOKE_VERTEX = /* glsl */ `
uniform float uTime;
uniform float uSpeed;
uniform vec3 uDrift;
uniform float uHeight;
uniform float uDriftLen;
uniform float uSize0;
uniform float uSize1;
uniform float uScale;
attribute float aSeed;
attribute vec3 aJitter;
varying float vAlpha;
void main() {
  float t = fract(aSeed + uTime * uSpeed);
  vec3 p = position;
  p.y += t * uHeight;
  p += uDrift * uDriftLen * pow(t, 1.35);
  p += aJitter * mix(0.35, 1.0, t) * uSize1 * 0.45;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float size = mix(uSize0, uSize1, t);
  gl_PointSize = clamp(size * uScale / max(0.5, -mv.z), 1.0, 900.0);
  gl_Position = projectionMatrix * mv;
  vAlpha = smoothstep(0.0, 0.1, t) * (1.0 - smoothstep(0.55, 1.0, t));
}
`;

const SMOKE_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - vec2(0.5));
  float a = smoothstep(0.5, 0.12, d) * vAlpha * uOpacity;
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}
`;

/** En el tema oscuro el humo negro se aclara un poco para que se distinga del suelo. */
function smokeColor(color: NSmoke["color"]): string {
  return color === "black" ? "#4a4f57" : SMOKE_HEX[color];
}

function SmokePlume({ s }: { s: NSmoke }) {
  const { animate, select, labels } = useSceneCtx();
  const pick = usePick("smoke", s.id);
  const selected = useIsSelected("smoke", s.id);
  const ref = useRef<THREE.Points>(null);
  const cfg = smokeConfig(s.volume, s.driftDeg !== null);
  const seed = useMemo(() => seedOf(s.id), [s.id]);
  const attrs = useMemo(() => {
    const pos = new Float32Array(cfg.count * 3);
    const seeds = new Float32Array(cfg.count);
    const jitter = new Float32Array(cfg.count * 3);
    for (let i = 0; i < cfg.count; i++) {
      seeds[i] = (i + rand(i, seed)) / cfg.count;
      jitter[i * 3] = rand(i, seed + 11) * 2 - 1;
      jitter[i * 3 + 1] = (rand(i, seed + 12) * 2 - 1) * 0.4;
      jitter[i * 3 + 2] = rand(i, seed + 13) * 2 - 1;
    }
    return { pos, seeds, jitter };
  }, [cfg.count, seed]);
  const drift = s.driftDeg === null ? [0, 0, 0] : headingToThree(s.driftDeg);
  const dx = drift[0];
  const dz = drift[2];
  // El componente se vuelve a montar (key) si cambian volumen, deriva o color: el programa
  // de la GPU toma los uniforms una sola vez.
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uSpeed: { value: cfg.speed },
      uDrift: { value: new THREE.Vector3(dx, 0, dz) },
      uHeight: { value: cfg.height },
      uDriftLen: { value: cfg.driftLen },
      uSize0: { value: cfg.size0 },
      uSize1: { value: cfg.size1 },
      uScale: { value: 400 },
      uColor: { value: new THREE.Color(smokeColor(s.color)) },
      uOpacity: { value: cfg.opacity },
    }),
    [cfg.speed, cfg.height, cfg.driftLen, cfg.size0, cfg.size1, cfg.opacity, dx, dz, s.color],
  );
  useFrame((state) => {
    const pts = ref.current;
    if (!pts) return;
    const m = pts.material as THREE.ShaderMaterial;
    const cam = state.camera as THREE.PerspectiveCamera;
    const fov = typeof cam.fov === "number" ? cam.fov : 45;
    m.uniforms.uScale.value = (state.size.height * state.viewport.dpr) / (2 * Math.tan((fov * Math.PI) / 360));
    if (animate) m.uniforms.uTime.value = state.clock.elapsedTime;
  });
  const top: Vec3 = [s.x + dx * cfg.driftLen * 0.5, s.z + cfg.height * 0.55, -s.y + dz * cfg.driftLen * 0.5];
  return (
    <group>
      <points ref={ref} position={[s.x, s.z, -s.y]} frustumCulled={false} renderOrder={5} raycast={() => undefined}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[attrs.pos, 3]} />
          <bufferAttribute attach="attributes-aSeed" args={[attrs.seeds, 1]} />
          <bufferAttribute attach="attributes-aJitter" args={[attrs.jitter, 3]} />
        </bufferGeometry>
        <shaderMaterial uniforms={uniforms} vertexShader={SMOKE_VERTEX} fragmentShader={SMOKE_FRAGMENT} transparent depthWrite={false} />
      </points>
      {/* Volumen invisible para seleccionar la columna */}
      <group {...pick}>
        <mesh position={top}>
          <sphereGeometry args={[Math.max(3, cfg.size1 * 0.6), 10, 8]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false} />
        </mesh>
      </group>
      {selected && labels && (
        <Label position={top} align="center" onActivate={() => select({ kind: "smoke", id: s.id })} ariaLabel="Columna de humo">
          <Chip tone="muted" selected>
            Columna de humo
          </Chip>
        </Label>
      )}
    </group>
  );
}

export function Smokes({ items }: { items: NSmoke[] }) {
  return (
    <group>
      {items.map((s) => (
        <SmokePlume key={`${s.id}|${s.volume}|${s.driftDeg}|${s.color}`} s={s} />
      ))}
    </group>
  );
}
