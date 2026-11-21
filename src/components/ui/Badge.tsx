import type { HTMLAttributes, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { toneBorder, toneDotBg, toneSoftBg, toneSolidBg, toneText, type Tone } from "./tone";

/** Estilos de relleno del badge. */
export type BadgeVariant = "soft" | "solid" | "outline";

/** Tamaños del badge; "lg" es el badge grande de estado. */
export type BadgeSize = "sm" | "md" | "lg";

const sizeClasses: Record<BadgeSize, string> = {
  sm: "min-h-5 gap-1 rounded px-1.5 py-0.5 text-[11px]",
  md: "min-h-6 gap-1.5 rounded px-2 py-1 text-xs",
  lg: "gap-2 rounded-md px-3 py-1.5 text-base",
};
const iconPx: Record<BadgeSize, number> = { sm: 12, md: 13, lg: 18 };
const dotSize: Record<BadgeSize, string> = { sm: "size-1.5", md: "size-1.5", lg: "size-2.5" };

/** Props de `Badge`. */
export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /** Color semántico; por defecto "neutral". */
  tone?: Tone;
  /** Relleno; por defecto "soft". */
  variant?: BadgeVariant;
  /** Tamaño; por defecto "sm". */
  size?: BadgeSize;
  /** Muestra un punto de color antes del texto. */
  dot?: boolean;
  /** Hace pulsar el punto (implica `dot`). */
  pulse?: boolean;
  /** Ícono antes del texto. */
  icon?: LucideIcon;
  className?: string;
  children?: ReactNode;
}

/** Etiqueta compacta en mayúsculas condensadas para estados, categorías y conteos. */
export function Badge({
  tone = "neutral",
  variant = "soft",
  size = "sm",
  dot = false,
  pulse = false,
  icon: Icon,
  className,
  children,
  ...rest
}: BadgeProps) {
  const colors =
    variant === "solid"
      ? cn("border-transparent text-on-solid", toneSolidBg[tone])
      : variant === "outline"
        ? cn("bg-transparent", toneText[tone], toneBorder[tone])
        : cn(toneSoftBg[tone], toneText[tone], toneBorder[tone]);
  const showDot = dot || pulse;

  return (
    <span
      className={cn(
        "label-caps inline-flex max-w-full shrink-0 items-center whitespace-nowrap border leading-none",
        sizeClasses[size],
        colors,
        className,
      )}
      {...rest}
    >
      {showDot ? (
        <span
          aria-hidden="true"
          className={cn(
            "inline-block shrink-0 rounded-full",
            dotSize[size],
            variant === "solid" ? "bg-current" : toneDotBg[tone],
            pulse && "animate-pulse-critical",
          )}
        />
      ) : null}
      {Icon ? <Icon aria-hidden="true" focusable="false" size={iconPx[size]} className="shrink-0" /> : null}
      {children != null && children !== false ? <span className="min-w-0 truncate">{children}</span> : null}
    </span>
  );
}
