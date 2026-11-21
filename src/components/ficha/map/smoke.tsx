"use client";
/**
 * Columna de humo sobre una casa con fuego: bocanadas que suben, crecen y se desvanecen,
 * inclinadas hacia donde deriva el viento. Es un marcador HTML (barato y sin WebGL extra);
 * FichaMap ajusta en cada movimiento las variables CSS de escala (px por metro), altura de
 * salida (el techo) e inclinación según el rumbo del mapa.
 */
import type { CSSProperties } from "react";
import type { SceneModel } from "@/lib/domain";

type Volume = SceneModel["smoke_plumes"][number]["volume"];
type SmokeColor = SceneModel["smoke_plumes"][number]["color"];

const RGB: Record<SmokeColor, string> = {
  black: "38 36 34",
  gray: "112 110 106",
  white: "196 196 192",
  brown: "112 86 60",
  yellow: "176 156 92",
  none: "150 148 144",
  unknown: "128 126 122",
};

const PUFFS: Record<Volume, number> = { none: 0, light: 6, moderate: 9, heavy: 13 };
const OPACITY: Record<Volume, number> = { none: 0, light: 0.42, moderate: 0.58, heavy: 0.72 };

/** Desorden fijo por bocanada (sin Math.random: el render es puro y estable). */
function jitter(i: number): number {
  return ((i * 7919) % 100) / 100 - 0.5;
}

export function SmokeColumn({ volume, color }: { volume: Volume; color: SmokeColor }) {
  const n = PUFFS[volume];
  if (!n) return null;
  const duration = volume === "heavy" ? 6.5 : 5.5;
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none relative size-0"
      // Sube desde la altura del techo (--smoke-lift, en px, lo calcula el mapa); la densidad va en la opacidad.
      style={{ transform: "translateY(calc(var(--smoke-lift, 0px) * -1))", opacity: OPACITY[volume] }}
    >
      {Array.from({ length: n }, (_, i) => {
        const style = {
          "--jx": `calc(var(--smoke-scale, 4px) * ${(jitter(i) * 3).toFixed(2)})`,
          width: `calc(var(--smoke-scale, 4px) * ${(volume === "heavy" ? 6 : 4.5) + jitter(i + 3) * 2})`,
          height: `calc(var(--smoke-scale, 4px) * ${(volume === "heavy" ? 6 : 4.5) + jitter(i + 3) * 2})`,
          background: `radial-gradient(circle, rgb(${RGB[color]} / 0.95) 0%, rgb(${RGB[color]} / 0.55) 40%, rgb(${RGB[color]} / 0) 70%)`,
          animation: `vg-smoke ${duration}s linear infinite`,
          animationDelay: `${(-duration * i) / n}s`,
        } as CSSProperties;
        return <span key={i} className="absolute top-0 left-0 rounded-full blur-[1px] motion-reduce:hidden" style={style} />;
      })}
      {/* Sin animación (movimiento reducido): una mancha fija de humo. */}
      <span
        className="absolute top-0 left-0 hidden -translate-x-1/2 -translate-y-full rounded-full blur-sm motion-reduce:block"
        style={{
          width: "calc(var(--smoke-scale, 4px) * 8)",
          height: "calc(var(--smoke-scale, 4px) * 16)",
          background: `radial-gradient(ellipse at 50% 70%, rgb(${RGB[color]} / 0.9) 0%, rgb(${RGB[color]} / 0) 70%)`,
        }}
      />
    </div>
  );
}
