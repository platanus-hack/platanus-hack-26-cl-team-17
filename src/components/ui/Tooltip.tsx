"use client";

import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";

/** Props de `Tooltip`. */
export interface TooltipProps {
  content: ReactNode;
  /** Disparador; se envuelve en un span para no clonar refs. */
  children: ReactElement;
  side?: "top" | "bottom" | "left" | "right";
  /** Retardo en ms antes de mostrar al pasar el puntero (por defecto 300). */
  delay?: number;
  className?: string;
}

const sideClass: Record<NonNullable<TooltipProps["side"]>, string> = {
  top: "bottom-full left-1/2 mb-1.5 -translate-x-1/2",
  bottom: "top-full left-1/2 mt-1.5 -translate-x-1/2",
  left: "right-full top-1/2 mr-1.5 -translate-y-1/2",
  right: "left-full top-1/2 ml-1.5 -translate-y-1/2",
};

type DescribedProps = { "aria-describedby"?: string };

/** Muestra si el foco llegó por teclado (evita abrir al hacer clic con el mouse). */
function isKeyboardFocus(target: EventTarget): boolean {
  if (!(target instanceof Element)) return false;
  try {
    return target.matches(":focus-visible");
  } catch {
    return true;
  }
}

/** Tooltip accesible: aparece al pasar el puntero o enfocar con teclado; Esc o perder el foco lo ocultan. */
export function Tooltip({ content, children, side = "top", delay = 300, className }: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const timer = useRef<number | null>(null);

  const clearTimer = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const hasContent = content !== null && content !== undefined && content !== false && content !== "";
  if (!hasContent) return children;

  const show = (wait: number) => {
    clearTimer();
    if (wait <= 0) setOpen(true);
    else timer.current = window.setTimeout(() => setOpen(true), wait);
  };

  const hide = () => {
    clearTimer();
    setOpen(false);
  };

  const onBlur = (event: FocusEvent<HTMLSpanElement>) => {
    const next = event.relatedTarget;
    if (!(next instanceof Node) || !event.currentTarget.contains(next)) hide();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== "Escape" || !open) return;
    // Primer Esc cierra solo el tooltip (no el diálogo que lo contenga).
    event.preventDefault();
    event.stopPropagation();
    hide();
  };

  const trigger = isValidElement<DescribedProps>(children)
    ? cloneElement(children, {
        "aria-describedby": cn(children.props["aria-describedby"], id) || undefined,
      })
    : children;

  return (
    <span
      className={cn("relative inline-flex max-w-full", className)}
      aria-describedby={id}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse" || event.pointerType === "pen") show(delay);
      }}
      onPointerLeave={hide}
      onFocus={(event) => {
        if (isKeyboardFocus(event.target)) show(0);
      }}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    >
      {trigger}
      <span
        id={id}
        role="tooltip"
        hidden={!open}
        className={cn(
          "pointer-events-none absolute z-50 w-max max-w-xs rounded-md border border-line bg-surface-2 px-2 py-1",
          "text-left font-sans text-xs font-normal normal-case leading-snug tracking-normal whitespace-normal text-text",
          "animate-fade-in",
          sideClass[side],
        )}
      >
        {content}
      </span>
    </span>
  );
}
