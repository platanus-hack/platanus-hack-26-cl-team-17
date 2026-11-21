"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Check, CircleX, Copy } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button, type ButtonProps } from "./Button";
import { IconButton } from "./IconButton";

/** Props de `CopyButton`: texto a copiar, rótulos y apariencia. */
export interface CopyButtonProps {
  value: string;
  label?: string;
  copiedLabel?: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  /** Solo icono (usa `IconButton`; el rótulo queda como aria-label y title). */
  iconOnly?: boolean;
  className?: string;
}

type CopyState = "idle" | "copied" | "error";

const COPIED_MS = 1800;
const ERROR_MS = 2500;
const ERROR_LABEL = "No se pudo copiar";

// Respaldo sin Clipboard API (HTTP en la LAN, navegadores antiguos). El textarea se inserta junto al
// botón y no en <body>: dentro de un <dialog> modal, lo que está fuera es inerte y no se puede seleccionar.
function copyWithTextarea(text: string, anchor: HTMLElement): boolean {
  const doc = anchor.ownerDocument;
  const host = anchor.parentElement ?? doc.body;
  const textarea = doc.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  textarea.tabIndex = -1;
  Object.assign(textarea.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "1px",
    height: "1px",
    padding: "0",
    border: "0",
    opacity: "0",
    pointerEvents: "none",
  });

  const selection = doc.getSelection();
  const previousRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  host.appendChild(textarea);
  textarea.focus({ preventScroll: true });
  textarea.select();
  textarea.setSelectionRange(0, text.length);

  let ok = false;
  try {
    ok = doc.execCommand("copy");
  } catch {
    ok = false;
  } finally {
    textarea.remove();
    if (selection && previousRange) {
      selection.removeAllRanges();
      selection.addRange(previousRange);
    }
    anchor.focus({ preventScroll: true });
  }
  return ok;
}

async function writeToClipboard(text: string, anchor: HTMLElement): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permiso denegado o documento sin foco: se intenta el respaldo.
    }
  }
  return copyWithTextarea(text, anchor);
}

/** Botón que copia `value` al portapapeles y confirma con un ícono de check durante 1,8 s. */
export function CopyButton({
  value,
  label = "Copiar",
  copiedLabel = "Copiado",
  variant,
  size,
  iconOnly = false,
  className,
}: CopyButtonProps) {
  const [state, setState] = useState<CopyState>("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  const handleClick = async (event: MouseEvent<HTMLElement>) => {
    const anchor = event.currentTarget;
    const ok = await writeToClipboard(value, anchor);
    if (!mountedRef.current) return;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    setState(ok ? "copied" : "error");
    timerRef.current = setTimeout(
      () => {
        timerRef.current = null;
        setState("idle");
      },
      ok ? COPIED_MS : ERROR_MS,
    );
  };

  const currentLabel = state === "copied" ? copiedLabel : state === "error" ? ERROR_LABEL : label;
  const icon = state === "copied" ? Check : state === "error" ? CircleX : Copy;
  const stateClass = cn(
    state === "copied" && variant !== "primary" && variant !== "danger" && "text-ok hover:text-ok",
    state === "error" && variant !== "primary" && variant !== "danger" && "text-critical hover:text-critical",
  );
  const announcement = state === "copied" ? copiedLabel : state === "error" ? ERROR_LABEL : "";

  return (
    <>
      {iconOnly ? (
        <IconButton
          icon={icon}
          label={currentLabel}
          variant={variant}
          size={size === "xl" ? "lg" : size}
          onClick={handleClick}
          className={cn(stateClass, className)}
        />
      ) : (
        <Button icon={icon} variant={variant} size={size} onClick={handleClick} className={cn(stateClass, className)}>
          {currentLabel}
        </Button>
      )}
      <span role="status" className="sr-only">
        {announcement}
      </span>
    </>
  );
}
