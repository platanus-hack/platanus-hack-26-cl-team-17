import Link from "next/link";
import { cn } from "@/lib/cn";
import { Logo } from "./Logo";

/** Bajada oficial de la marca. */
export const BRAND_TAGLINE = "Puesto de mando asistido por IA para Bomberos";

/** Props del logotipo completo (isotipo + nombre). */
export interface WordmarkProps {
  size?: "sm" | "md" | "lg" | "xl";
  /** Muestra la bajada bajo el nombre. */
  tagline?: boolean;
  /** Si se indica, el logotipo es un enlace. */
  href?: string;
  className?: string;
}

const SIZES = {
  sm: { logo: 22, name: "text-lg", gap: "gap-2", tagline: "text-xs" },
  md: { logo: 28, name: "text-2xl", gap: "gap-2.5", tagline: "text-sm" },
  lg: { logo: 44, name: "text-4xl", gap: "gap-3", tagline: "text-base" },
  xl: { logo: 60, name: "text-6xl", gap: "gap-4", tagline: "text-lg" },
} as const;

/** Logotipo de Vigía: isotipo + "VIGÍA" en tipografía condensada, con bajada opcional. */
export function Wordmark({ size = "md", tagline = false, href, className }: WordmarkProps) {
  const s = SIZES[size];
  const content = (
    <>
      <Logo size={s.logo} title="" className="text-text" />
      <span className="flex min-w-0 flex-col">
        <span className={cn("font-display leading-none font-semibold text-text", s.name)}>
          Vigía
        </span>
        {tagline ? (
          <span className={cn("mt-1 leading-snug text-muted", s.tagline)}>{BRAND_TAGLINE}</span>
        ) : null}
      </span>
    </>
  );

  const base = cn("inline-flex items-center", s.gap, className);

  if (href) {
    return (
      <Link href={href} className={cn(base, "rounded-md")}>
        {content}
      </Link>
    );
  }
  return <span className={base}>{content}</span>;
}
