"use client";

import { useRef, type KeyboardEvent, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

/** Opción de `SegmentedControl`. */
export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: LucideIcon;
  disabled?: boolean;
}

/** Props de `SegmentedControl` (controlado). */
export interface SegmentedControlProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (v: T) => void;
  size?: "sm" | "md" | "lg";
  fullWidth?: boolean;
  ariaLabel: string;
  className?: string;
}

type Size = NonNullable<SegmentedControlProps<string>["size"]>;

const sizeClass: Record<Size, string> = {
  sm: "h-6 px-2 text-xs gap-1 label-caps",
  md: "h-8 px-3 text-sm gap-1.5 label-caps",
  lg: "h-11 px-4 text-base gap-2 font-sans font-semibold",
};

const iconSize: Record<Size, number> = { sm: 12, md: 14, lg: 18 };

/** Selector de una opción entre pocas (radiogroup) con flechas, Inicio y Fin. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  fullWidth = false,
  ariaLabel,
  className,
}: SegmentedControlProps<T>) {
  const buttons = useRef(new Map<T, HTMLButtonElement>());

  const enabled = options.filter((o) => !o.disabled);
  const focusableValue: T | undefined = enabled.some((o) => o.value === value) ? value : enabled[0]?.value;

  const select = (v: T) => {
    buttons.current.get(v)?.focus();
    if (v !== value) onChange(v);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (enabled.length === 0) return;
    const current = (event.target as HTMLElement).dataset.value;
    const index = enabled.findIndex((o) => o.value === current);
    let next: number | null = null;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = index < 0 ? 0 : (index + 1) % enabled.length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
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
    select(enabled[next].value);
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={cn(
        "items-stretch gap-0.5 rounded-full border border-line bg-surface-2 p-0.5",
        fullWidth ? "flex w-full" : "inline-flex",
        className,
      )}
    >
      {options.map((option) => {
        const checked = option.value === value;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            ref={(node) => {
              if (node) buttons.current.set(option.value, node);
              else buttons.current.delete(option.value);
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={option.disabled}
            tabIndex={option.value === focusableValue ? 0 : -1}
            data-value={option.value}
            onClick={() => select(option.value)}
            className={cn(
              "inline-flex min-w-0 items-center justify-center whitespace-nowrap rounded-full border transition-colors",
              sizeClass[size],
              fullWidth && "flex-1",
              checked
                ? "border-line-strong bg-surface font-semibold text-text"
                : "border-transparent text-muted hover:bg-surface hover:text-text",
              option.disabled && "cursor-not-allowed opacity-50 hover:bg-transparent hover:text-muted",
            )}
          >
            {Icon && <Icon aria-hidden="true" size={iconSize[size]} className="shrink-0" />}
            <span className="truncate">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
