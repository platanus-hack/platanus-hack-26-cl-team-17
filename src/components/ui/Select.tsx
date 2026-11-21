import type { Ref, SelectHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { controlBaseClass, controlStateClass, type ControlSize } from "./Input";

/** Opción de `Select`. */
export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/** Props de `Select`: `<select>` nativo (sin `size`) con opciones, marcador y tamaño. */
export type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "size" | "children"> & {
  options: SelectOption[];
  /** Primera opción vacía y deshabilitada (p. ej. "Elige una opción"). */
  placeholder?: string;
  invalid?: boolean;
  size?: ControlSize;
  ref?: Ref<HTMLSelectElement>;
};

const sizeClass: Record<ControlSize, string> = {
  md: "h-9 pl-3 pr-9 text-sm",
  lg: "h-11 pl-3.5 pr-10 text-base",
  xl: "h-14 pl-4 pr-12 text-lg",
};

const chevronClass: Record<ControlSize, string> = {
  md: "right-2.5 size-4",
  lg: "right-3 size-[18px]",
  xl: "right-4 size-5",
};

/** Selector nativo con estilo del sistema. `className` se aplica al contenedor. */
export function Select({
  options,
  placeholder,
  invalid,
  size = "md",
  className,
  ref,
  value,
  defaultValue,
  ...rest
}: SelectProps) {
  // Sin valor inicial, el navegador elegiría la primera opción habilitada: se fuerza el marcador.
  const initial = placeholder !== undefined && value === undefined && defaultValue === undefined ? "" : defaultValue;

  return (
    <div className={cn("relative min-w-0", className)}>
      <select
        ref={ref}
        {...rest}
        value={value}
        defaultValue={initial}
        aria-invalid={invalid ? true : rest["aria-invalid"]}
        className={cn(
          controlBaseClass,
          controlStateClass(invalid),
          sizeClass[size],
          "cursor-pointer appearance-none",
          "has-[option[value='']:checked]:text-faint",
          "[&>option]:bg-surface [&>option]:text-text",
        )}
      >
        {placeholder !== undefined && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden="true"
        className={cn("pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted", chevronClass[size])}
      />
    </div>
  );
}
