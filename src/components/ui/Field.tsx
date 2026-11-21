import type { ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import { cn } from "@/lib/cn";

/** Props de `Field`: rótulo, ayuda y error alrededor de un control de formulario. */
export interface FieldProps {
  label: ReactNode;
  /** id del control; si falta, el rótulo envuelve al control (asociación implícita). */
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  optional?: boolean;
  className?: string;
  children: ReactNode;
}

/** ids que `Field` asigna a la ayuda y al error, para enlazarlos con `aria-describedby` en el control. */
export function fieldMessageIds(htmlFor: string): { hint: string; error: string } {
  return { hint: `${htmlFor}-hint`, error: `${htmlFor}-error` };
}

/** Envoltorio de campo: rótulo en mayúsculas, control, texto de ayuda y mensaje de error. */
export function Field({ label, htmlFor, hint, error, required, optional, className, children }: FieldProps) {
  const ids = htmlFor ? fieldMessageIds(htmlFor) : null;
  const hasError = error !== undefined && error !== null && error !== false && error !== "";
  const hasHint = hint !== undefined && hint !== null && hint !== false && hint !== "";

  const labelContent = (
    <>
      {label}
      {required && (
        <>
          <span aria-hidden="true" className="text-critical">
            {" *"}
          </span>
          <span className="sr-only"> (obligatorio)</span>
        </>
      )}
      {optional && !required && (
        <span className="font-sans text-faint normal-case tracking-normal font-normal"> (opcional)</span>
      )}
    </>
  );
  const labelClass = "label-caps block text-xs text-muted";

  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      {htmlFor ? (
        <>
          <label htmlFor={htmlFor} className={labelClass}>
            {labelContent}
          </label>
          {children}
        </>
      ) : (
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className={labelClass}>{labelContent}</span>
          {children}
        </label>
      )}
      {hasHint && (
        <p id={ids?.hint} className="text-xs text-faint">
          {hint}
        </p>
      )}
      {hasError && (
        <p id={ids?.error} className="flex items-start gap-1.5 text-sm text-critical">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
