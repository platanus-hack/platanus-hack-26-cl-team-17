import type { HTMLAttributes, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

/** Props de `EmptyState`: mensaje para listas o vistas sin contenido. */
export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, "title" | "children"> {
  /** Ícono ilustrativo. */
  icon?: LucideIcon;
  /** Frase principal (qué pasa). */
  title: string;
  /** Explicación breve o siguiente paso. */
  description?: ReactNode;
  /** Acción sugerida (normalmente un `Button`). */
  action?: ReactNode;
  /** Variante en línea, para paneles pequeños. */
  compact?: boolean;
  className?: string;
}

/** Estado vacío: ícono, título, descripción y acción opcional, centrado o compacto. */
export function EmptyState({ icon: Icon, title, description, action, compact = false, className, ...rest }: EmptyStateProps) {
  if (compact) {
    return (
      <div {...rest} className={cn("flex items-start gap-2.5 px-3 py-3 text-sm", className)}>
        {Icon && <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-faint" />}
        <div className="min-w-0 flex-1">
          <p className="font-medium text-text">{title}</p>
          {description != null && <div className="mt-0.5 text-muted">{description}</div>}
          {action != null && <div className="mt-2">{action}</div>}
        </div>
      </div>
    );
  }

  return (
    <div
      {...rest}
      className={cn("flex flex-col items-center justify-center px-6 py-10 text-center", className)}
    >
      {Icon && (
        <div className="mb-3 flex size-11 items-center justify-center rounded-full border border-line bg-surface-2">
          <Icon aria-hidden="true" className="size-5 text-muted" />
        </div>
      )}
      <p className="font-display text-lg font-semibold text-text">{title}</p>
      {description != null && <div className="mt-1 max-w-sm text-sm text-muted">{description}</div>}
      {action != null && <div className="mt-4 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}
