"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type Ref,
  type TextareaHTMLAttributes,
} from "react";
import { cn } from "@/lib/cn";
import { controlBaseClass, controlStateClass } from "./Input";

/** Props de `Textarea`: atributos nativos más estado inválido y crecimiento automático. */
export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  invalid?: boolean;
  /** Crece con el contenido hasta `maxRows` filas; luego aparece la barra de desplazamiento. */
  autoGrow?: boolean;
  /** Máximo de filas visibles con `autoGrow` (por defecto 8). */
  maxRows?: number;
  ref?: Ref<HTMLTextAreaElement>;
};

function px(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/** Área de texto multilínea, opcionalmente autoajustable en altura. */
export function Textarea({
  invalid,
  autoGrow = false,
  maxRows = 8,
  rows = 3,
  className,
  ref,
  onInput,
  ...rest
}: TextareaProps) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  const { value } = rest;

  // Une la ref interna (para medir) con la ref del consumidor, respetando limpiezas de React 19.
  const setRefs = useCallback(
    (node: HTMLTextAreaElement) => {
      innerRef.current = node;
      const cleanup = typeof ref === "function" ? ref(node) : undefined;
      if (ref && typeof ref !== "function") ref.current = node;
      return () => {
        innerRef.current = null;
        if (typeof ref === "function") {
          if (typeof cleanup === "function") cleanup();
          else ref(null);
        } else if (ref) {
          ref.current = null;
        }
      };
    },
    [ref],
  );

  const resize = useCallback(() => {
    const el = innerRef.current;
    if (!el) return;
    if (!autoGrow) {
      el.style.height = "";
      el.style.overflowY = "";
      return;
    }
    const cs = window.getComputedStyle(el);
    const lineHeight = px(cs.lineHeight) || px(cs.fontSize) * 1.25 || 20;
    const border = px(cs.borderTopWidth) + px(cs.borderBottomWidth);
    const padding = px(cs.paddingTop) + px(cs.paddingBottom);
    const max = maxRows > 0 ? lineHeight * maxRows + padding + border : Number.POSITIVE_INFINITY;
    el.style.height = "auto";
    const full = el.scrollHeight + border;
    el.style.height = `${Math.min(full, max)}px`;
    el.style.overflowY = full > max ? "auto" : "hidden";
  }, [autoGrow, maxRows]);

  useLayoutEffect(() => {
    resize();
  }, [resize, value, rows]);

  // Un cambio de ancho cambia el ajuste de línea; se recalcula solo en ese caso para no entrar en bucle.
  useEffect(() => {
    const el = innerRef.current;
    if (!autoGrow || !el || typeof ResizeObserver === "undefined") return;
    let lastWidth = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth !== lastWidth) {
        lastWidth = el.clientWidth;
        resize();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [autoGrow, resize]);

  const handleInput: NonNullable<TextareaProps["onInput"]> = (event) => {
    onInput?.(event);
    resize();
  };

  return (
    <textarea
      ref={setRefs}
      rows={rows}
      {...rest}
      onInput={handleInput}
      aria-invalid={invalid ? true : rest["aria-invalid"]}
      className={cn(
        controlBaseClass,
        controlStateClass(invalid),
        "block px-3 py-2 text-sm leading-5",
        autoGrow ? "resize-none" : "resize-y",
        className,
      )}
    />
  );
}
