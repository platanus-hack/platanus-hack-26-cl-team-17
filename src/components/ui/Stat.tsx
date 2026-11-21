import type { HTMLAttributes, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { toneText, type Tone } from "@/components/ui/tone";

/** Props de `Stat`: cifra destacada con rótulo. */
export interface StatProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** Rótulo (en mayúsculas condensadas). */
  label: string;
  /** Valor principal. */
  value: ReactNode;
  /** Texto auxiliar bajo el valor (unidad, comparación, fuente). */
  hint?: ReactNode;
  /** Colorea el valor; neutral usa el color de texto normal. */
  tone?: Tone;
  /** Ícono junto al rótulo. */
  icon?: LucideIcon;
  /** Tamaño del valor. */
  size?: "sm" | "md" | "lg";
  className?: string;
}

const valueSize: Record<NonNullable<StatProps["size"]>, string> = {
  sm: "text-xl",
  md: "text-3xl",
  lg: "text-5xl",
};

/** Indicador numérico: rótulo, valor grande en tipografía condensada y pista opcional. */
export function Stat({ label, value, hint, tone = "neutral", icon: Icon, size = "md", className, ...rest }: StatProps) {
  return (
    <div {...rest} className={cn("flex min-w-0 flex-col gap-1", className)}>
      <div className="flex items-center gap-1.5 text-muted">
        {Icon && <Icon aria-hidden="true" className={cn("size-3.5 shrink-0", tone !== "neutral" && toneText[tone])} />}
        <span className="label-caps truncate text-xs">{label}</span>
      </div>
      <div
        className={cn(
          "font-display font-semibold leading-none tabular",
          valueSize[size],
          tone === "neutral" ? "text-text" : toneText[tone],
        )}
      >
        {value}
      </div>
      {hint != null && <div className="text-xs text-faint">{hint}</div>}
    </div>
  );
}
