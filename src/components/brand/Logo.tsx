import type { SVGAttributes } from "react";
import { cn } from "@/lib/cn";

/** Props del isotipo de Vigía. */
export interface LogoProps extends Omit<SVGAttributes<SVGSVGElement>, "children"> {
  /** Lado en píxeles (cuadrado). */
  size?: number;
  className?: string;
  /** Nombre accesible. Con cadena vacía el logo queda decorativo (aria-hidden). */
  title?: string;
}

/** Isotipo de Vigía: visor de mira con un ojo vigía y pupila en color de acento. Se lee a 16 px. */
export function Logo({ size = 28, className, title = "Vigía", ...rest }: LogoProps) {
  const decorative = title === "";
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      fill="none"
      focusable="false"
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : title}
      aria-hidden={decorative ? true : undefined}
      className={cn("shrink-0", className)}
      {...rest}
    >
      {decorative ? null : <title>{title}</title>}
      <g stroke="currentColor" strokeWidth={2}>
        {/* Esquinas de visor: trazos de 2 unidades sobre coordenadas impares quedan nítidos a 16 px. */}
        <path strokeLinecap="square" d="M3 10V3h7M22 3h7v7M29 22v7h-7M10 29H3v-7" />
        <path
          strokeWidth={2.5}
          strokeLinejoin="round"
          d="M5.5 16c3.4-4.9 6.9-7 10.5-7s7.1 2.1 10.5 7c-3.4 4.9-6.9 7-10.5 7s-7.1-2.1-10.5-7Z"
        />
      </g>
      <circle cx={16} cy={16} r={4} fill="currentColor" className="text-accent" />
    </svg>
  );
}
