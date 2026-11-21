"use client";

import { useRef, type HTMLAttributes, type KeyboardEvent, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

/** Pestaña individual de `Tabs`. */
export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
  icon?: LucideIcon;
  /** Conteo pequeño junto al rótulo. */
  count?: number;
  /** Punto crítico pulsante (algo requiere atención en esa pestaña). */
  alert?: boolean;
  disabled?: boolean;
}

/** Props de `Tabs` (controlado). */
export interface TabsProps<T extends string> {
  tabs: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  size?: "sm" | "md";
  fullWidth?: boolean;
  ariaLabel?: string;
  /** Prefijo de ids; debe coincidir con el de cada `TabPanel`. Usa uno distinto por grupo en la misma página. */
  idPrefix?: string;
  className?: string;
}

const DEFAULT_PREFIX = "tabs";

const sizeClass: Record<NonNullable<TabsProps<string>["size"]>, string> = {
  sm: "h-8 px-2.5 text-xs gap-1.5",
  md: "h-10 px-3 text-sm gap-2",
};

const iconSize: Record<NonNullable<TabsProps<string>["size"]>, number> = { sm: 14, md: 16 };

/** Id del botón de una pestaña. */
function tabId(prefix: string, id: string): string {
  return `${prefix}-tab-${id}`;
}

/** Id del panel asociado a una pestaña. */
function panelId(prefix: string, id: string): string {
  return `${prefix}-panel-${id}`;
}

/** Barra de pestañas controlada con tabindex itinerante y navegación por flechas, Inicio y Fin. */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  size = "md",
  fullWidth = false,
  ariaLabel,
  idPrefix = DEFAULT_PREFIX,
  className,
}: TabsProps<T>) {
  const buttons = useRef(new Map<T, HTMLButtonElement>());

  const enabled = tabs.filter((t) => !t.disabled);
  const selectedEnabled = enabled.some((t) => t.id === value);
  // Si la pestaña activa no existe o está deshabilitada, la primera habilitada recibe el foco del Tab.
  const focusableId: T | undefined = selectedEnabled ? value : enabled[0]?.id;

  const select = (id: T) => {
    buttons.current.get(id)?.focus();
    if (id !== value) onChange(id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (enabled.length === 0) return;
    const currentId = (event.target as HTMLElement).dataset.tabId;
    const index = enabled.findIndex((t) => t.id === currentId);
    let next: number | null = null;
    switch (event.key) {
      case "ArrowRight":
        next = index < 0 ? 0 : (index + 1) % enabled.length;
        break;
      case "ArrowLeft":
        next = index < 0 ? enabled.length - 1 : (index - 1 + enabled.length) % enabled.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = enabled.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    select(enabled[next].id);
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      onKeyDown={onKeyDown}
      className={cn("flex min-w-0 items-stretch overflow-x-auto border-b border-line", className)}
    >
      {tabs.map((tab) => {
        const selected = tab.id === value;
        const Icon = tab.icon;
        return (
          <button
            key={tab.id}
            ref={(node) => {
              if (node) buttons.current.set(tab.id, node);
              else buttons.current.delete(tab.id);
            }}
            type="button"
            role="tab"
            id={tabId(idPrefix, tab.id)}
            aria-controls={panelId(idPrefix, tab.id)}
            aria-selected={selected}
            aria-disabled={tab.disabled || undefined}
            disabled={tab.disabled}
            tabIndex={tab.id === focusableId ? 0 : -1}
            data-tab-id={tab.id}
            onClick={() => select(tab.id)}
            className={cn(
              "relative -mb-px inline-flex shrink-0 items-center justify-center whitespace-nowrap border-b-2 label-caps transition-colors",
              "focus-visible:-outline-offset-2",
              sizeClass[size],
              fullWidth && "flex-1",
              selected
                ? "border-accent text-text"
                : "border-transparent text-muted hover:border-line-strong hover:text-text",
              tab.disabled && "cursor-not-allowed opacity-50 hover:border-transparent hover:text-muted",
            )}
          >
            {Icon && <Icon aria-hidden="true" size={iconSize[size]} className="shrink-0" />}
            <span className="truncate">{tab.label}</span>
            {typeof tab.count === "number" && (
              <span
                className={cn(
                  "tabular min-w-5 rounded-sm px-1 text-center font-mono text-[10px] leading-4 tracking-normal",
                  selected ? "bg-accent-soft text-text" : "bg-surface-2 text-muted",
                )}
              >
                {tab.count}
              </span>
            )}
            {tab.alert && (
              <>
                <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-critical animate-pulse-critical" />
                <span className="sr-only">(requiere atención)</span>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Props de `TabPanel`. */
export interface TabPanelProps extends Omit<HTMLAttributes<HTMLDivElement>, "id" | "children" | "hidden"> {
  /** Id de la pestaña (el mismo `id` usado en `Tabs`). */
  id: string;
  idPrefix?: string;
  active: boolean;
  /** Oculta en vez de desmontar cuando no está activo (por defecto true, así el panel no se remonta). */
  keepMounted?: boolean;
  className?: string;
  children?: ReactNode;
}

/** Panel asociado a una pestaña de `Tabs`; se oculta (o desmonta) cuando no está activo. */
export function TabPanel({
  id,
  idPrefix = DEFAULT_PREFIX,
  active,
  keepMounted = true,
  className,
  children,
  ...rest
}: TabPanelProps) {
  if (!active && !keepMounted) return null;
  return (
    <div
      {...rest}
      role="tabpanel"
      id={panelId(idPrefix, id)}
      aria-labelledby={tabId(idPrefix, id)}
      hidden={!active}
      tabIndex={0}
      className={cn("focus-visible:-outline-offset-2", className)}
    >
      {children}
    </div>
  );
}
