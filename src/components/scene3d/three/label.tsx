"use client";
/**
 * Etiquetas HTML ancladas a un punto 3D (drei <Html>, sin fuentes ni texturas de red).
 * Quedan dentro del contexto de apilamiento del visor, bajo los paneles del marco.
 */
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode, RefObject } from "react";
import { Html } from "@react-three/drei";
import type { Vec3 } from "../geometry";
import type { Tone } from "../icons";
import { TONE_CHIP, cx } from "../tones";
import { useSceneCtx } from "./context";

/** Rango de z-index por importancia (las personas en riesgo quedan siempre encima). */
const Z_RANGE = {
  base: [20, 0],
  high: [32, 21],
  critical: [44, 33],
} as const satisfies Record<string, [number, number]>;

export type LabelLayer = keyof typeof Z_RANGE;

const ANCHOR: Record<"above" | "center" | "right", string> = {
  above: "translate(-50%, calc(-100% - 6px))",
  center: "translate(-50%, -50%)",
  right: "translate(10px, -50%)",
};

/** Halo del color de fondo para leer texto suelto sobre cualquier cosa. */
export const HALO: CSSProperties = {
  textShadow: "0 0 3px var(--color-bg), 0 0 2px var(--color-bg), 0 0 1px var(--color-bg), 0 0 1px var(--color-bg)",
};

const stop = (e: ReactPointerEvent) => e.stopPropagation();

export interface LabelProps {
  position: Vec3;
  children: ReactNode;
  layer?: LabelLayer;
  align?: keyof typeof ANCHOR;
  /** Si existe, la etiqueta es un botón (selecciona la entidad). */
  onActivate?: () => void;
  ariaLabel?: string;
  title?: string;
}

export function Label({ position, children, layer = "base", align = "above", onActivate, ariaLabel, title }: LabelProps) {
  const { overlayRef } = useSceneCtx();
  return (
    <Html
      position={position}
      // Destino fijo: si drei cambia de contenedor desmonta y remonta la raíz de React en pleno render.
      portal={overlayRef as RefObject<HTMLElement>}
      zIndexRange={[...Z_RANGE[layer]]}
      style={{ pointerEvents: "none" }}
    >
      <div className="w-max font-sans select-none" style={{ transform: ANCHOR[align] }}>
        {onActivate ? (
          <button
            type="button"
            aria-label={ariaLabel}
            title={title}
            onPointerDown={stop}
            onClick={(e) => {
              e.stopPropagation();
              onActivate();
            }}
            className="pointer-events-auto block cursor-pointer rounded text-left focus-visible:outline-2 focus-visible:outline-info"
          >
            {children}
          </button>
        ) : (
          children
        )}
      </div>
    </Html>
  );
}

/** Ficha de etiqueta con el estilo del tono (borde y fondo del sistema de diseño). */
export function Chip({
  tone,
  selected,
  children,
  className,
}: {
  tone: Tone;
  selected?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] leading-tight font-semibold shadow-[0_1px_4px_rgb(0_0_0/0.45)]",
        TONE_CHIP[tone],
        selected && "outline-2 outline-offset-1 outline-info",
        className,
      )}
    >
      {children}
    </span>
  );
}
