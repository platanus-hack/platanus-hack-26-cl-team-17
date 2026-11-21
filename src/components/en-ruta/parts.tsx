import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

/** Bloque de la tablet: título en mayúsculas grandes y contenido legible a un metro. */
export function BriefSection({
  id,
  title,
  icon: Icon,
  aside,
  className,
  children,
}: {
  id: string;
  title: string;
  icon?: LucideIcon;
  /** Contenido a la derecha del título (insignias, botones). */
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className={cn("rounded-lg border border-line bg-surface p-4 lg:p-5", className)}>
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 id={id} className="label-caps flex min-w-0 items-center gap-2 text-lg text-text lg:text-xl">
          {Icon && <Icon aria-hidden className="size-5 shrink-0 text-muted lg:size-6" />}
          {title}
        </h2>
        {aside && <div className="ml-auto flex flex-wrap items-center gap-2">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

export type PillTone = "neutral" | "critical" | "warning" | "ok" | "info" | "accent";

const PILL_TONE: Record<PillTone, string> = {
  neutral: "border-line-strong bg-surface-2 text-text",
  critical: "border-transparent bg-critical text-on-solid",
  warning: "border-transparent bg-warning text-on-solid",
  ok: "border-ok/50 bg-ok-soft text-ok",
  info: "border-info/50 bg-info-soft text-info",
  accent: "border-accent/50 bg-accent-soft text-accent",
};

/** Insignia grande que puede ocupar dos líneas (las de `ui` se truncan). */
export function Pill({
  tone = "neutral",
  icon: Icon,
  className,
  children,
}: {
  tone?: PillTone;
  icon?: LucideIcon;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-md border px-2.5 py-1 text-base leading-tight font-semibold",
        PILL_TONE[tone],
        className,
      )}
    >
      {Icon && <Icon aria-hidden className="size-4 shrink-0" />}
      <span className="min-w-0">{children}</span>
    </span>
  );
}
