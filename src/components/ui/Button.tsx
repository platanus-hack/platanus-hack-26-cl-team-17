import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode, Ref } from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { Spinner, type SpinnerSize } from "./Spinner";

/** Variantes visuales de botón. */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

/** Tamaños de botón: 28/36/44/56 px de alto (xl es el de las pantallas de vecinos). */
export type ButtonSize = "sm" | "md" | "lg" | "xl";

/** Clases de color por variante (fondo, borde, texto y hover), reutilizables por otros controles. */
export const buttonVariantClasses: Record<ButtonVariant, string> = {
  primary: "border-transparent bg-primary text-on-primary hover:bg-primary/85 active:bg-primary/75",
  secondary:
    "border-line bg-surface-2 text-text hover:border-line-strong hover:bg-line/50 active:bg-line/70",
  ghost: "border-transparent bg-transparent text-muted hover:bg-surface-2 hover:text-text active:bg-line/50",
  danger: "border-transparent bg-critical text-on-solid hover:bg-critical/90 active:bg-critical/80",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-8 gap-1.5 px-3 font-display text-[13px] font-bold",
  md: "h-9 gap-2 px-4 font-display text-[15px] font-bold",
  lg: "h-12 gap-2 px-5 font-display text-[17px] font-bold",
  // Vecinos: texto normal (sin mayúsculas condensadas), legible al sol; puede ocupar dos líneas.
  xl: "min-h-14 gap-2.5 px-6 py-3 font-sans text-lg font-bold leading-tight whitespace-normal text-center",
};

const iconPx: Record<ButtonSize, number> = { sm: 14, md: 16, lg: 18, xl: 22 };
const spinnerSize: Record<ButtonSize, SpinnerSize> = { sm: "xs", md: "sm", lg: "sm", xl: "md" };

/** Props de `Button`; con `href` se renderiza como enlace (next/link, o `<a>` externo). */
export type ButtonProps = {
  /** Estilo visual; por defecto "secondary". */
  variant?: ButtonVariant;
  /** Alto del control; por defecto "md". */
  size?: ButtonSize;
  /** Muestra un spinner, deshabilita el botón, conserva el ancho y marca aria-busy. */
  loading?: boolean;
  /** Ícono antes del texto. */
  icon?: LucideIcon;
  /** Ícono después del texto. */
  iconRight?: LucideIcon;
  /** Ocupa todo el ancho disponible. */
  fullWidth?: boolean;
  /** Destino: convierte el botón en enlace. */
  href?: string;
  /** Con `href`: abre en pestaña nueva con `<a target="_blank" rel="noopener noreferrer">`. */
  external?: boolean;
  /** Referencia al `<button>` (no se aplica en modo enlace). */
  ref?: Ref<HTMLButtonElement>;
  className?: string;
  children?: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement | HTMLAnchorElement>, "children">;

/** Botón de acción con variantes, tamaños, íconos, estado de carga y modo enlace. */
export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon: Icon,
  iconRight: IconRight,
  fullWidth = false,
  href,
  external = false,
  ref,
  className,
  children,
  type = "button",
  disabled,
  form,
  formAction,
  formEncType,
  formMethod,
  formNoValidate,
  formTarget,
  name,
  value,
  onClick,
  ...rest
}: ButtonProps) {
  const inactive = Boolean(disabled) || loading;
  const px = iconPx[size];

  const classes = cn(
    "relative inline-flex shrink-0 select-none items-center justify-center rounded-full border",
    "whitespace-nowrap transition-colors duration-150",
    "disabled:cursor-not-allowed disabled:not-aria-busy:opacity-50",
    "aria-disabled:cursor-not-allowed aria-disabled:not-aria-busy:opacity-50 aria-busy:cursor-wait",
    buttonVariantClasses[variant],
    sizeClasses[size],
    fullWidth && "flex w-full",
    className,
  );

  const content = (
    <>
      {/* Con `loading` el contenido queda invisible (no se quita) para conservar el ancho. */}
      <span className={cn("inline-flex min-w-0 items-center justify-center gap-[inherit]", loading && "opacity-0")}>
        {Icon ? <Icon aria-hidden="true" focusable="false" size={px} className="shrink-0" /> : null}
        {children != null && children !== false ? <span className="min-w-0">{children}</span> : null}
        {IconRight ? <IconRight aria-hidden="true" focusable="false" size={px} className="shrink-0" /> : null}
      </span>
      {loading ? (
        <span className="absolute inset-0 flex items-center justify-center">
          <Spinner size={spinnerSize[size]} />
        </span>
      ) : null}
    </>
  );

  if (href !== undefined) {
    // Sin handlers propios: así Button sigue siendo un Server Component (Next no permite pasar
    // funciones a next/link desde el servidor). Un enlace inactivo se renderiza como texto inerte.
    if (inactive) {
      return (
        <span {...(rest as HTMLAttributes<HTMLSpanElement>)} role="link" aria-disabled="true" aria-busy={loading || undefined} className={cn(classes, "cursor-not-allowed")}>
          {content}
        </span>
      );
    }
    const linkState = {
      "aria-disabled": inactive || undefined,
      "aria-busy": loading || undefined,
      tabIndex: inactive ? -1 : rest.tabIndex,
    };

    if (external) {
      return (
        <a
          {...rest}
          {...linkState}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className={classes}
          onClick={onClick}
        >
          {content}
          <span className="sr-only"> (se abre en una pestaña nueva)</span>
        </a>
      );
    }

    return (
      <Link {...rest} {...linkState} href={href} className={classes} onClick={onClick}>
        {content}
      </Link>
    );
  }

  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      disabled={inactive}
      aria-busy={loading || undefined}
      form={form}
      formAction={formAction}
      formEncType={formEncType}
      formMethod={formMethod}
      formNoValidate={formNoValidate}
      formTarget={formTarget}
      name={name}
      value={value}
      onClick={onClick}
      className={classes}
    >
      {content}
    </button>
  );
}
