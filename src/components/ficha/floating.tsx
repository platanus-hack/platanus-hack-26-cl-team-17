"use client";
/**
 * Controles de la ventana flotante de la ficha (video del dron ↔ mapa). Van encima de lo que
 * muestre la ventana: tocarla en cualquier parte la pasa al centro y el centro pasa a la ventana;
 * abajo a la derecha se minimiza. Minimizada queda una pastilla en la misma esquina.
 */
import type { CSSProperties } from "react";
import { ArrowLeftRight, Minus, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { GLASS } from "./parts";

const ROUND =
  "grid size-8 place-items-center rounded-full bg-paper/92 text-f-ink shadow-[0_2px_8px_rgb(0_0_0/0.25)] backdrop-blur-md transition-colors hover:bg-paper";

export function FloatingControls({
  style,
  what,
  badge,
  onSwap,
  onHide,
}: {
  style: CSSProperties;
  /** Lo que muestra la ventana ("el video", "el mapa"), para los rótulos de los botones. */
  what: string;
  /** Rótulo arriba a la izquierda, para lo que no trae el suyo (el mapa). */
  badge?: string | null;
  onSwap: () => void;
  onHide: () => void;
}) {
  return (
    <div className="absolute z-[26]" style={style}>
      <button
        type="button"
        onClick={onSwap}
        aria-label={`Ver ${what} en grande`}
        title={`Ver ${what} en grande`}
        className="absolute inset-0 rounded-xl ring-inset transition-shadow hover:ring-2 hover:ring-white/80 focus-visible:ring-2 focus-visible:ring-f-orange focus-visible:outline-none"
      >
        {badge && (
          <span className="absolute top-2 left-2 rounded-md bg-paper/92 px-2 py-1 text-[12px] font-semibold text-f-ink shadow-[0_2px_8px_rgb(0_0_0/0.18)]">
            {badge}
          </span>
        )}
        <span aria-hidden="true" className={cn(ROUND, "absolute right-11 bottom-2")}>
          <ArrowLeftRight className="size-4" />
        </span>
      </button>
      <button type="button" onClick={onHide} aria-label="Minimizar la ventana" title="Minimizar" className={cn(ROUND, "absolute right-2 bottom-2")}>
        <Minus className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}

export function FloatingPill({
  style,
  icon: Icon,
  label,
  onShow,
}: {
  style: CSSProperties;
  icon: LucideIcon;
  label: string;
  onShow: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onShow}
      className={cn(GLASS, "absolute z-[26] inline-flex h-10 items-center gap-2 rounded-xl px-3 text-[14px] font-semibold text-f-ink hover:bg-paper")}
      style={style}
    >
      <Icon className="size-4" aria-hidden="true" />
      {label}
    </button>
  );
}
