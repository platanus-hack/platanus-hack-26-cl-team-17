import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { toneDotBg, type Tone } from "./tone";

/** Tamaños del punto de estado (6/8/12 px). */
export type StatusDotSize = "sm" | "md" | "lg";

const sizeClasses: Record<StatusDotSize, string> = { sm: "size-1.5", md: "size-2", lg: "size-3" };

/** Props de `StatusDot`. */
export interface StatusDotProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  /** Color semántico; por defecto "neutral". */
  tone?: Tone;
  /** Pulso de atención (para estados críticos en curso). */
  pulse?: boolean;
  /** Diámetro; por defecto "md" (8 px). */
  size?: StatusDotSize;
  /** Texto solo para lectores de pantalla; sin él, el punto es decorativo. */
  label?: string;
  className?: string;
}

/** Punto de color de estado; acompáñalo de texto visible o de `label` para no depender solo del color. */
export function StatusDot({ tone = "neutral", pulse = false, size = "md", label, className, ...rest }: StatusDotProps) {
  const dot = (
    <span
      aria-hidden="true"
      className={cn("inline-block shrink-0 rounded-full", sizeClasses[size], toneDotBg[tone], pulse && "animate-pulse-critical")}
    />
  );

  if (!label) {
    return (
      <span aria-hidden="true" className={cn("inline-flex shrink-0 items-center", className)} {...rest}>
        {dot}
      </span>
    );
  }

  return (
    <span className={cn("inline-flex shrink-0 items-center", className)} {...rest}>
      {dot}
      <span className="sr-only">{label}</span>
    </span>
  );
}
