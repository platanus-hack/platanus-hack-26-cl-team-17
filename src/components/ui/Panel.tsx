import { useId, type HTMLAttributes, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { toneSolidBg, toneText, type Tone } from "@/components/ui/tone";

/** Props de `Panel`: contenedor con barra de título, cuerpo y pie opcionales. */
export interface PanelProps extends Omit<HTMLAttributes<HTMLElement>, "title" | "children"> {
  /** Título de la barra superior (rótulo en mayúsculas). */
  title?: ReactNode;
  /** Ícono a la izquierda del título. */
  icon?: LucideIcon;
  /** Acciones alineadas a la derecha de la barra de título. */
  actions?: ReactNode;
  /** Insignia junto al título (p. ej. un conteo o estado). */
  badge?: ReactNode;
  /** Pie del panel, separado por un borde superior. */
  footer?: ReactNode;
  /** El panel ocupa toda la altura disponible y el cuerpo hace scroll propio. */
  scroll?: boolean;
  /** Cuerpo sin relleno interno (para listas, mapas o tablas a borde). */
  flush?: boolean;
  /** Franja de color a la izquierda de la barra de título (si no es neutral). */
  tone?: Tone;
  /** Elemento raíz. */
  as?: "section" | "div" | "aside";
  /** Clases extra del cuerpo. */
  bodyClassName?: string;
  className?: string;
  children?: ReactNode;
  id?: string;
}

/** Panel de consola: superficie con borde, barra de título compacta, cuerpo y pie. */
export function Panel({
  title,
  icon: Icon,
  actions,
  badge,
  footer,
  scroll = false,
  flush = false,
  tone = "neutral",
  as: Root = "section",
  bodyClassName,
  className,
  children,
  id,
  ...rest
}: PanelProps) {
  const autoId = useId();
  const titleId = `${id ?? autoId}-title`;
  const hasTitle = title !== undefined && title !== null && title !== false && title !== "";
  const hasBar = hasTitle || Boolean(Icon) || actions != null || badge != null;
  // Solo los landmarks (section/aside) se rotulan con el título; un div no tiene rol que nombrar.
  const labelledBy = hasTitle && Root !== "div" ? titleId : undefined;

  return (
    <Root
      id={id}
      aria-labelledby={labelledBy}
      {...rest}
      className={cn(
        "overflow-hidden rounded-lg border border-line bg-surface",
        scroll && "flex h-full min-h-0 flex-col",
        className,
      )}
    >
      {hasBar && (
        <div className="relative flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
          {tone !== "neutral" && (
            <span aria-hidden="true" className={cn("absolute inset-y-0 left-0 w-0.5", toneSolidBg[tone])} />
          )}
          {Icon && (
            <Icon
              aria-hidden="true"
              className={cn("size-3.5 shrink-0", tone !== "neutral" ? toneText[tone] : "text-muted")}
            />
          )}
          {hasTitle && (
            <h2 id={titleId} className="label-caps min-w-0 truncate text-xs text-muted">
              {title}
            </h2>
          )}
          {badge != null && <div className="flex shrink-0 items-center">{badge}</div>}
          {actions != null && <div className="ml-auto flex shrink-0 items-center gap-1">{actions}</div>}
        </div>
      )}
      <div
        className={cn(
          !flush && "p-3",
          scroll && "min-h-0 flex-1 overflow-y-auto",
          bodyClassName,
        )}
      >
        {children}
      </div>
      {footer != null && (
        <div className="shrink-0 border-t border-line px-3 py-2 text-sm text-muted">{footer}</div>
      )}
    </Root>
  );
}
