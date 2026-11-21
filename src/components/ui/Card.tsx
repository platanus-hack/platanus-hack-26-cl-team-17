import type { AriaAttributes, HTMLAttributes, KeyboardEvent, ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";
import type { Tone } from "@/components/ui/tone";

/** Props de `Card`: tarjeta seleccionable o enlazable. */
export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Realce al pasar el cursor, anillo de foco y cursor de mano. Con `onClick` se vuelve operable por teclado. */
  interactive?: boolean;
  /** Marca la tarjeta como seleccionada (borde de acento). */
  selected?: boolean;
  /** Borde izquierdo de 3 px en el color del tono (si no es neutral). */
  tone?: Tone;
  /** Si se indica, la tarjeta es un enlace (`next/link`) en bloque. */
  href?: string;
  /** Relleno interno. */
  padding?: "none" | "sm" | "md";
  className?: string;
  children?: ReactNode;
}

const toneLeftBorder: Record<Tone, string> = {
  neutral: "",
  accent: "border-l-[3px] border-l-accent",
  critical: "border-l-[3px] border-l-critical",
  warning: "border-l-[3px] border-l-warning",
  ok: "border-l-[3px] border-l-ok",
  info: "border-l-[3px] border-l-info",
  drone: "border-l-[3px] border-l-drone",
};

const paddingClass: Record<NonNullable<CardProps["padding"]>, string> = {
  none: "",
  sm: "p-2.5",
  md: "p-3",
};

const interactiveClass =
  "cursor-pointer transition-colors hover:border-line-strong hover:bg-surface-2/60 focus-visible:border-line-strong";

/** Tarjeta de superficie con borde; opcionalmente interactiva, seleccionada, con tono o enlace. */
export function Card({
  interactive = false,
  selected = false,
  tone = "neutral",
  href,
  padding = "md",
  className,
  children,
  ...rest
}: CardProps) {
  const classes = cn(
    "block rounded-lg border bg-surface text-text",
    selected ? "border-accent" : "border-line",
    toneLeftBorder[tone],
    paddingClass[padding],
    (interactive || href !== undefined) && interactiveClass,
    className,
  );

  if (href !== undefined) {
    // Un enlace solo recibe atributos neutros (id, title, aria-*); los manejadores de un div no aplican.
    const aria: AriaAttributes = {
      "aria-label": rest["aria-label"],
      "aria-labelledby": rest["aria-labelledby"],
      "aria-describedby": rest["aria-describedby"],
      "aria-current": rest["aria-current"] ?? (selected ? "true" : undefined),
    };
    return (
      <Link href={href} id={rest.id} title={rest.title} {...aria} data-selected={selected || undefined} className={classes}>
        {children}
      </Link>
    );
  }

  const { onClick, onKeyDown, role, tabIndex } = rest;
  const operable = interactive && onClick !== undefined;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.currentTarget.click();
    }
  };

  return (
    <div
      {...rest}
      role={operable ? (role ?? "button") : role}
      tabIndex={operable ? (tabIndex ?? 0) : tabIndex}
      aria-current={rest["aria-current"] ?? (selected ? "true" : undefined)}
      onKeyDown={operable ? handleKeyDown : onKeyDown}
      data-selected={selected || undefined}
      className={classes}
    >
      {children}
    </div>
  );
}
