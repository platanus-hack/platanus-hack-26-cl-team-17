import type { HTMLAttributes } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

/** Tamaños del indicador de carga (12/16/20/32 px). */
export type SpinnerSize = "xs" | "sm" | "md" | "lg";

const sizePx: Record<SpinnerSize, number> = { xs: 12, sm: 16, md: 20, lg: 32 };

/** Props de `Spinner`. */
export interface SpinnerProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  /** Tamaño del ícono; por defecto "sm" (16 px). */
  size?: SpinnerSize;
  /** Texto para lectores de pantalla; por defecto "Cargando". */
  label?: string;
  className?: string;
}

/** Indicador de carga giratorio con texto accesible (role="status"); hereda el color del texto. */
export function Spinner({ size = "sm", label = "Cargando", className, ...rest }: SpinnerProps) {
  return (
    <span role="status" className={cn("inline-flex shrink-0 items-center justify-center", className)} {...rest}>
      <Loader2 aria-hidden="true" focusable="false" size={sizePx[size]} className="animate-spin" />
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}
