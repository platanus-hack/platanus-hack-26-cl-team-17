"use client";

import { useId, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Props de `Switch`: interruptor controlado con rótulo y descripción opcional. */
export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  id?: string;
  className?: string;
}

/** Interruptor encendido/apagado (`role="switch"`); el rótulo también lo alterna al hacer clic. */
export function Switch({ checked, onChange, label, description, disabled, id, className }: SwitchProps) {
  const autoId = useId();
  const switchId = id ?? `switch-${autoId}`;
  const descriptionId = description ? `${switchId}-description` : undefined;

  return (
    <div className={cn("flex items-start gap-3", disabled && "opacity-50", className)}>
      <button
        type="button"
        role="switch"
        id={switchId}
        aria-checked={checked}
        aria-describedby={descriptionId}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors",
          "disabled:cursor-not-allowed",
          checked ? "border-accent bg-accent" : "border-line-strong bg-surface-2 hover:border-muted",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "block size-3.5 rounded-full transition-transform",
            checked ? "translate-x-[18px] bg-on-solid" : "translate-x-[2px] bg-muted",
          )}
        />
      </button>
      <div className="min-w-0">
        <label
          htmlFor={switchId}
          className={cn("block text-sm leading-6 text-text select-none", disabled ? "cursor-not-allowed" : "cursor-pointer")}
        >
          {label}
        </label>
        {description && (
          <p id={descriptionId} className="text-xs text-muted">
            {description}
          </p>
        )}
      </div>
    </div>
  );
}
