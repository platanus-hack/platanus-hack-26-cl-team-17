import type { InputHTMLAttributes, Ref } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

/** Tamaños de los controles de texto: md 36 px, lg 44 px, xl 56 px (pantallas de vecinos). */
export type ControlSize = "md" | "lg" | "xl";

/** Clases base compartidas por Input, Textarea y Select. */
export const controlBaseClass =
  "w-full min-w-0 rounded-md border bg-surface-2 text-text placeholder:text-faint outline-hidden transition-colors " +
  "hover:border-line-strong focus:border-info focus:ring-1 focus:ring-info " +
  "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-line";

/** Clases de borde según estado de validez. */
export function controlStateClass(invalid: boolean | undefined): string {
  return invalid
    ? "border-critical hover:border-critical focus:border-critical focus:ring-critical"
    : "border-line";
}

const sizeClass: Record<ControlSize, string> = {
  md: "h-9 px-3 text-sm",
  lg: "h-11 px-3.5 text-base",
  xl: "h-14 px-4 text-lg",
};

const iconPadClass: Record<ControlSize, string> = {
  md: "pl-9",
  lg: "pl-10",
  xl: "pl-12",
};

const iconClass: Record<ControlSize, string> = {
  md: "left-3 size-4",
  lg: "left-3.5 size-[18px]",
  xl: "left-4 size-5",
};

/** Props de `Input`: atributos nativos (sin `size`) más estado inválido, icono y tamaño. */
export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & {
  invalid?: boolean;
  /** Icono decorativo dentro del campo, a la izquierda. */
  icon?: LucideIcon;
  size?: ControlSize;
  ref?: Ref<HTMLInputElement>;
};

/** Campo de texto. Con `icon`, `className` se aplica al contenedor; sin icono, al `<input>`. */
export function Input({ invalid, icon: Icon, size = "md", className, ref, type = "text", ...rest }: InputProps) {
  const ariaInvalid = invalid ? true : rest["aria-invalid"];
  const inputClass = cn(controlBaseClass, controlStateClass(invalid), sizeClass[size], Icon && iconPadClass[size]);

  if (!Icon) {
    return <input ref={ref} type={type} {...rest} aria-invalid={ariaInvalid} className={cn(inputClass, className)} />;
  }

  return (
    <div className={cn("relative min-w-0", className)}>
      <Icon
        aria-hidden="true"
        className={cn("pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted", iconClass[size])}
      />
      <input ref={ref} type={type} {...rest} aria-invalid={ariaInvalid} className={inputClass} />
    </div>
  );
}
