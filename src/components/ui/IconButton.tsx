import type { ButtonHTMLAttributes, HTMLAttributes, Ref } from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { Spinner, type SpinnerSize } from "./Spinner";
import { buttonVariantClasses } from "./Button";

/** Variantes visuales del botón de ícono. */
export type IconButtonVariant = "ghost" | "secondary" | "primary" | "danger";

/** Tamaños del botón de ícono: cuadrado de 28/36/44 px. */
export type IconButtonSize = "sm" | "md" | "lg";

const sizeClasses: Record<IconButtonSize, string> = {
  sm: "size-7",
  md: "size-9",
  lg: "size-11",
};
const iconPx: Record<IconButtonSize, number> = { sm: 14, md: 16, lg: 20 };
const spinnerSize: Record<IconButtonSize, SpinnerSize> = { sm: "xs", md: "sm", lg: "md" };

// Estado "presionado" (aria-pressed): reemplaza los colores de la variante (cn no fusiona clases en conflicto).
const activeClasses: Record<IconButtonVariant, string> = {
  ghost: "border-accent/40 bg-accent-soft text-accent hover:border-accent/60",
  secondary: "border-accent/40 bg-accent-soft text-accent hover:border-accent/60",
  primary: `${buttonVariantClasses.primary} ring-2 ring-accent/40 ring-offset-1 ring-offset-bg`,
  danger: `${buttonVariantClasses.danger} ring-2 ring-critical/40 ring-offset-1 ring-offset-bg`,
};

/** Props de `IconButton`; `label` es obligatorio porque el botón no tiene texto visible. */
export type IconButtonProps = {
  /** Ícono a mostrar. */
  icon: LucideIcon;
  /** Nombre accesible (aria-label) y tooltip nativo (title). */
  label: string;
  /** Estilo visual; por defecto "ghost". */
  variant?: IconButtonVariant;
  /** Tamaño del cuadrado; por defecto "md". */
  size?: IconButtonSize;
  /** Reemplaza el ícono por un spinner, deshabilita y marca aria-busy. */
  loading?: boolean;
  /** Destino: convierte el botón en enlace (next/link). */
  href?: string;
  /** Botón de alternancia: expone aria-pressed y lo resalta cuando es true. */
  active?: boolean;
  /** Referencia al `<button>` (no se aplica en modo enlace). */
  ref?: Ref<HTMLButtonElement>;
  className?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement | HTMLAnchorElement>, "children">;

/** Botón cuadrado solo con ícono, con nombre accesible, estado de alternancia y modo enlace. */
export function IconButton({
  icon: Icon,
  label,
  variant = "ghost",
  size = "md",
  loading = false,
  href,
  active,
  ref,
  className,
  type = "button",
  disabled,
  title,
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
}: IconButtonProps) {
  const inactive = Boolean(disabled) || loading;

  const classes = cn(
    "relative inline-flex shrink-0 select-none items-center justify-center rounded-md border transition-colors duration-150",
    "disabled:cursor-not-allowed disabled:not-aria-busy:opacity-50",
    "aria-disabled:cursor-not-allowed aria-disabled:not-aria-busy:opacity-50 aria-busy:cursor-wait",
    active ? activeClasses[variant] : buttonVariantClasses[variant],
    sizeClasses[size],
    className,
  );

  const content = loading ? (
    <Spinner size={spinnerSize[size]} label="" />
  ) : (
    <Icon aria-hidden="true" focusable="false" size={iconPx[size]} />
  );

  if (href !== undefined) {
    // Ver Button: sin handlers propios para seguir siendo Server Component.
    if (inactive) {
      return (
        <span {...(rest as HTMLAttributes<HTMLSpanElement>)} role="link" aria-label={label} title={title ?? label} aria-disabled="true" aria-busy={loading || undefined} className={cn(classes, "cursor-not-allowed")}>
          {content}
        </span>
      );
    }
    return (
      <Link
        {...rest}
        href={href}
        aria-label={label}
        title={title ?? label}
        aria-current={active ? "page" : rest["aria-current"]}
        aria-disabled={inactive || undefined}
        aria-busy={loading || undefined}
        tabIndex={inactive ? -1 : rest.tabIndex}
        className={classes}
        onClick={onClick}
      >
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
      aria-label={label}
      title={title ?? label}
      aria-pressed={active}
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
