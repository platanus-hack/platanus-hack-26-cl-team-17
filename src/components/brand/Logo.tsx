import { useId, type SVGAttributes } from "react";
import { cn } from "@/lib/cn";

/** Colores de marca (archivo «Vigilia – Logo» de Figma). */
export const BRAND = {
  rojoBombero: "#E8362F",
  ambarFaro: "#FFB020",
  carbon: "#151A21",
  humo: "#F4F1EC",
} as const;

/** Props del isotipo. */
export interface LogoProps extends Omit<SVGAttributes<SVGSVGElement>, "children"> {
  /** Lado en píxeles (cuadrado). */
  size?: number;
  className?: string;
  /** Nombre accesible. Con cadena vacía el logo queda decorativo (aria-hidden). */
  title?: string;
}

/**
 * Isotipo: faro con torre roja de tres franjas, lámpara ámbar con halo y dos haces que se
 * desvanecen. Geometría tomada del Mark de 200 × 200 del archivo de Figma, recortado a su
 * contenido en un cuadrado de 150.
 */
export function Logo({ size = 28, className, title = "vigilia", ...rest }: LogoProps) {
  const decorative = title === "";
  const id = useId().replace(/:/g, "");
  const left = `beam-l-${id}`;
  const right = `beam-r-${id}`;
  return (
    <svg
      viewBox="25 27 150 150"
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
      <defs>
        <linearGradient id={left} x1="100" y1="72.7" x2="27.3" y2="72.7" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={BRAND.ambarFaro} stopOpacity="0.95" />
          <stop offset="1" stopColor={BRAND.ambarFaro} stopOpacity="0" />
        </linearGradient>
        <linearGradient id={right} x1="100" y1="72.7" x2="172.7" y2="72.7" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={BRAND.ambarFaro} stopOpacity="0.95" />
          <stop offset="1" stopColor={BRAND.ambarFaro} stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* Haces de luz */}
      <path d="M100 72.7 L27.3 39.1 L27.3 106.3 Z" fill={`url(#${left})`} />
      <path d="M100 72.7 L172.7 39.1 L172.7 106.3 Z" fill={`url(#${right})`} />
      {/* Halo y lámpara */}
      <circle cx="100" cy="72.6" r="16.4" fill={BRAND.ambarFaro} fillOpacity="0.2" />
      <circle cx="100" cy="72.7" r="8.6" fill={BRAND.ambarFaro} />
      {/* Torre: tres franjas que se ensanchan hacia abajo */}
      <path d="M89.1 84 L110.9 84 L113.9 109.4 L86.1 109.4 Z" fill={BRAND.rojoBombero} />
      <path d="M85.5 114.1 L114.5 114.1 L117.2 137.5 L82.8 137.5 Z" fill={BRAND.rojoBombero} />
      <path d="M82.3 142.2 L117.7 142.2 L120.3 164.1 L79.7 164.1 Z" fill={BRAND.rojoBombero} />
    </svg>
  );
}
