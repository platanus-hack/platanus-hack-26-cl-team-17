import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { formatPercent } from "@/lib/format";
import { toneSolidBg, type Tone } from "@/components/ui/tone";

/** Props de `ProgressBar`: barra de avance determinada o indeterminada. */
export interface ProgressBarProps extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "role"> {
  /** Avance entre 0 y 1; `null` = indeterminado. */
  value: number | null;
  /** Color del relleno. */
  tone?: Tone;
  /** Nombre accesible (aria-label). */
  label?: string;
  /** Muestra el porcentaje a la derecha ("63 %"). */
  showValue?: boolean;
  /** Grosor de la barra. */
  size?: "sm" | "md";
  className?: string;
}

/** Barra de progreso accesible (role="progressbar"); `value=null` la deja indeterminada. */
export function ProgressBar({
  value,
  tone = "accent",
  label = "Progreso",
  showValue = false,
  size = "md",
  className,
  ...rest
}: ProgressBarProps) {
  const ratio = value === null ? null : Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  const text = ratio === null ? null : formatPercent(ratio);

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div
        {...rest}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={ratio === null ? undefined : Math.round(ratio * 100)}
        aria-valuetext={text ?? "En curso"}
        aria-busy={ratio === null || undefined}
        className={cn("relative min-w-0 flex-1 overflow-hidden rounded-full bg-line", size === "sm" ? "h-1" : "h-2")}
      >
        {ratio === null ? (
          <div className={cn("absolute inset-0 animate-pulse opacity-70", toneSolidBg[tone])} />
        ) : (
          <div
            className={cn("h-full rounded-full transition-[width] duration-300 ease-out", toneSolidBg[tone])}
            style={{ width: `${ratio * 100}%` }}
          />
        )}
      </div>
      {showValue && (
        <span aria-hidden="true" className="min-w-[4.5ch] shrink-0 text-right font-mono text-xs text-muted tabular">
          {text ?? "—"}
        </span>
      )}
    </div>
  );
}
