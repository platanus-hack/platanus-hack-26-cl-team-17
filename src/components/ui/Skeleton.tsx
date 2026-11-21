import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

/** Props de `Skeleton`. */
export interface SkeletonProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** Sin `lines`: define el tamaño del bloque (por defecto `h-4 w-full`). Con `lines`: clases del contenedor. */
  className?: string;
  /** Renderiza N barras de texto apiladas (la última más corta). */
  lines?: number;
  /** Bordes totalmente redondeados (avatares, píldoras). */
  rounded?: boolean;
}

// Anchos alternados para que varias líneas parezcan un párrafo.
const lineWidths = ["w-full", "w-11/12", "w-4/5", "w-full", "w-3/4"];

/** Marcador de contenido en carga (bloque o líneas); decorativo, oculto a lectores de pantalla. */
export function Skeleton({ className, lines, rounded = false, ...rest }: SkeletonProps) {
  const radius = rounded ? "rounded-full" : "rounded-md";
  const count = lines === undefined ? 0 : Math.max(1, Math.floor(lines));

  if (count === 0) {
    return (
      <div
        aria-hidden="true"
        className={cn("animate-pulse bg-surface-2", radius, className ?? "h-4 w-full")}
        {...rest}
      />
    );
  }

  return (
    <div aria-hidden="true" className={cn("flex w-full flex-col gap-2", className)} {...rest}>
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className={cn(
            "h-3 animate-pulse bg-surface-2",
            radius,
            count > 1 && i === count - 1 ? "w-3/5" : lineWidths[i % lineWidths.length],
          )}
        />
      ))}
    </div>
  );
}
