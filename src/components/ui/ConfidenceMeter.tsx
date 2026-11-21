import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import type { Confidence } from "@/lib/domain";
import { toneSolidBg, toneText, type Tone } from "@/components/ui/tone";

/** Props de `ConfidenceMeter`: nivel de confianza en barras. */
export interface ConfidenceMeterProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children" | "title"> {
  /** Nivel de confianza. */
  level: Confidence;
  /** Muestra el texto "Confianza baja/media/alta" junto a las barras. */
  showLabel?: boolean;
  /** Tamaño de las barras y del texto. */
  size?: "sm" | "md";
  className?: string;
}

const levelSpec: Record<Confidence, { bars: number; tone: Tone; text: string }> = {
  low: { bars: 1, tone: "warning", text: "Confianza baja" },
  medium: { bars: 2, tone: "info", text: "Confianza media" },
  high: { bars: 3, tone: "ok", text: "Confianza alta" },
};

const barHeights: Record<NonNullable<ConfidenceMeterProps["size"]>, readonly [string, string, string]> = {
  sm: ["h-1.5", "h-2.5", "h-3"],
  md: ["h-2", "h-3", "h-4"],
};

/** Medidor de confianza: 1–3 barras verticales (baja=advertencia, media=info, alta=ok) con texto. */
export function ConfidenceMeter({ level, showLabel = true, size = "md", className, ...rest }: ConfidenceMeterProps) {
  const spec = levelSpec[level];
  const heights = barHeights[size];

  return (
    <span
      {...rest}
      title={spec.text}
      data-level={level}
      className={cn("inline-flex items-center gap-1.5 align-middle", size === "sm" ? "text-xs" : "text-sm", className)}
    >
      <span aria-hidden="true" className="inline-flex items-end gap-[2px]">
        {heights.map((height, index) => (
          <span
            key={height}
            className={cn(
              "rounded-[1px]",
              size === "sm" ? "w-[3px]" : "w-1",
              height,
              index < spec.bars ? toneSolidBg[spec.tone] : "bg-line",
            )}
          />
        ))}
      </span>
      {/* El texto siempre llega al lector de pantalla: visible o solo para lectores. */}
      <span className={showLabel ? cn("font-medium", toneText[spec.tone]) : "sr-only"}>{spec.text}</span>
    </span>
  );
}
