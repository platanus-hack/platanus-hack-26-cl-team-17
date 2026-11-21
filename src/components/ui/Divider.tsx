import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

/** Props de `Divider`. */
export interface DividerProps extends Omit<HTMLAttributes<HTMLElement>, "children"> {
  /** Dirección de la línea; por defecto "horizontal". */
  orientation?: "horizontal" | "vertical";
  /** Rótulo centrado en mayúsculas condensadas. */
  label?: string;
  className?: string;
}

/** Separador de 1 px, horizontal o vertical, con rótulo centrado opcional. */
export function Divider({ orientation = "horizontal", label, className, ...rest }: DividerProps) {
  const vertical = orientation === "vertical";

  if (!label) {
    return (
      <div
        role="separator"
        aria-orientation={orientation}
        className={cn("shrink-0 bg-line", vertical ? "w-px self-stretch" : "h-px w-full", className)}
        {...rest}
      />
    );
  }

  const line = <span aria-hidden="true" className={cn("flex-1 bg-line", vertical ? "w-px" : "h-px")} />;

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      className={cn(
        "flex shrink-0 items-center gap-3",
        vertical ? "flex-col self-stretch" : "w-full flex-row",
        className,
      )}
      {...rest}
    >
      {line}
      <span aria-hidden="true" className="label-caps text-xs text-muted">
        {label}
      </span>
      {line}
    </div>
  );
}
