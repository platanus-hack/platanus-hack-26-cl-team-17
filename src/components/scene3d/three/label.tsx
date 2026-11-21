"use client";
/**
 * Etiquetas HTML ancladas a un punto 3D (drei <Html>, sin fuentes ni texturas de red) y
 * despeje automático: si dos etiquetas se tapan, se oculta la de menor prioridad. Las
 * personas en riesgo, el atrapamiento y la entidad seleccionada quedan siempre visibles.
 */
import { useCallback, useEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from "react";
import * as THREE from "three";
import { addAfterEffect, useFrame, useThree } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import type { Vec3 } from "../geometry";
import type { Tone } from "../icons";
import { TONE_CHIP, cx } from "../tones";
import { useSceneCtx } from "./context";
import { declutter } from "./pose";

/* ───────────────────────────── Registro y despeje ───────────────────────────── */

interface Entry {
  el: HTMLElement;
  priority: number;
  pinned: boolean;
  /** Corrimiento aplicado en el último despeje. */
  dx: number;
  dy: number;
}

/** Etiquetas montadas; `layout()` mide en pantalla y oculta las que quedan tapadas. */
export class LabelRegistry {
  private items = new Map<number, Entry>();
  private seq = 0;
  private wake: (() => void) | null = null;
  /** Zona visible en coordenadas de pantalla; lo que cae fuera se oculta y no compite en el despeje. */
  private clip: (() => DOMRect | null) | null = null;
  dirty = true;

  setClip(fn: (() => DOMRect | null) | null) {
    this.clip = fn;
    this.touch();
  }

  setWake(fn: (() => void) | null) {
    this.wake = fn;
  }

  add(el: HTMLElement, priority: number, pinned: boolean): () => void {
    const id = ++this.seq;
    this.items.set(id, { el, priority, pinned, dx: 0, dy: 0 });
    this.touch();
    return () => {
      this.items.delete(id);
      this.touch();
    };
  }

  touch() {
    this.dirty = true;
    this.wake?.();
  }

  layout() {
    const all = [...this.items.values()];
    const clip = this.clip?.() ?? null;
    // Caja en su lugar natural (sin el corrimiento del despeje anterior).
    const measured = all.map((e) => {
      const r = e.el.getBoundingClientRect();
      return { x: r.left - e.dx, y: r.top - e.dy, w: r.width, h: r.height, priority: e.priority, pinned: e.pinned };
    });
    const inside = (b: (typeof measured)[number]) => {
      if (!clip) return true;
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      return cx >= clip.left && cx <= clip.right && cy >= clip.top && cy <= clip.bottom;
    };
    const outside = all.filter((_, i) => !inside(measured[i]));
    for (const e of outside) if (e.el.style.visibility !== "hidden") e.el.style.visibility = "hidden";
    const entries = all.filter((_, i) => inside(measured[i]));
    const boxes = measured.filter((b) => inside(b));
    const placement = declutter(boxes);
    entries.forEach((e, i) => {
      const p = placement[i];
      const v = p.visible ? "" : "hidden";
      if (e.el.style.visibility !== v) e.el.style.visibility = v;
      if (p.visible && (p.dx !== e.dx || p.dy !== e.dy)) {
        e.dx = p.dx;
        e.dy = p.dy;
        e.el.style.translate = p.dx || p.dy ? `${Math.round(p.dx)}px ${Math.round(p.dy)}px` : "";
      }
    });
    this.dirty = false;
  }
}

/** Corre el despeje después de cada cuadro en que se movió la cámara, cambió el tamaño o las etiquetas. */
export function LabelLayout({ registry }: { registry: LabelRegistry }) {
  const invalidate = useThree((s) => s.invalidate);
  const lastCam = useRef(new THREE.Matrix4());
  const lastSize = useRef("");
  const pending = useRef(true);
  useEffect(() => {
    registry.setWake(invalidate);
    const off = addAfterEffect(() => {
      if (!pending.current) return;
      pending.current = false;
      registry.layout();
    });
    return () => {
      off();
      registry.setWake(null);
    };
  }, [registry, invalidate]);
  useFrame((state) => {
    const size = `${state.size.width}x${state.size.height}`;
    if (registry.dirty || size !== lastSize.current || !state.camera.matrixWorld.equals(lastCam.current)) {
      lastCam.current.copy(state.camera.matrixWorld);
      lastSize.current = size;
      pending.current = true;
    }
  });
  return null;
}

/* ───────────────────────────── Etiqueta ───────────────────────────── */

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

export interface LabelProps {
  position: Vec3;
  children: ReactNode;
  /** Prioridad para el despeje (mayor = gana). */
  priority: number;
  /** Nunca se oculta por despeje. */
  pinned?: boolean;
  layer?: LabelLayer;
  align?: keyof typeof ANCHOR;
  /** Si existe, la etiqueta es un botón (selecciona la entidad). */
  onActivate?: () => void;
  ariaLabel?: string;
  title?: string;
}

export function Label({ position, children, priority, pinned = false, layer = "base", align = "above", onActivate, ariaLabel, title }: LabelProps) {
  const { overlayRef, labelRegistry } = useSceneCtx();
  const attach = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) return;
      return labelRegistry.add(el, priority, pinned);
    },
    [labelRegistry, priority, pinned],
  );
  return (
    <Html
      position={position}
      // Destino fijo: si drei cambia de contenedor desmonta y remonta su raíz de React en pleno render.
      portal={overlayRef as RefObject<HTMLElement>}
      zIndexRange={[...Z_RANGE[pinned ? "critical" : layer]]}
      style={{ pointerEvents: "none" }}
    >
      <div ref={attach} className="w-max font-sans select-none" style={{ transform: ANCHOR[align] }}>
        {onActivate ? (
          <button
            type="button"
            aria-label={ariaLabel}
            title={title}
            onClick={(e) => {
              e.stopPropagation();
              onActivate();
            }}
            className="group pointer-events-auto block cursor-pointer rounded text-left focus-visible:outline-2 focus-visible:outline-info"
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
        "inline-flex items-center gap-1 rounded-[2px] border px-1.5 py-0.5 font-mono text-[10.5px] leading-tight font-medium shadow-[0_1px_2px_rgb(15_20_25/0.12)]",
        TONE_CHIP[tone],
        selected && "outline-2 outline-offset-1 outline-info",
        className,
      )}
    >
      {children}
    </span>
  );
}
