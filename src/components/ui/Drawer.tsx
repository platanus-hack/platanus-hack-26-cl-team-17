"use client";

import { useId, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { useModalDialog } from "./Dialog";
import { IconButton } from "./IconButton";

/** Props de `Drawer`. */
export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  side?: "right" | "left";
  /** Ancho en px (por defecto 420; nunca más que el viewport). */
  width?: number;
  footer?: ReactNode;
  className?: string;
  children?: ReactNode;
}

/** Panel lateral modal sobre `<dialog>` nativo; Esc o clic en el fondo cierran, con trampa de foco. */
export function Drawer({
  open,
  onClose,
  title,
  side = "right",
  width = 420,
  footer,
  className,
  children,
}: DrawerProps) {
  const titleId = useId();
  const bindings = useModalDialog({ open, onClose });

  return (
    <dialog
      {...bindings}
      aria-labelledby={titleId}
      style={{ width: `min(${Math.max(0, width)}px, 100vw)` }}
      className={cn(
        "fixed inset-y-0 m-0 h-dvh max-h-dvh max-w-[100vw] overflow-hidden bg-surface p-0 text-text",
        "focus-visible:outline-none",
        side === "right"
          ? "right-0 left-auto border-l border-line animate-slide-in-right"
          : "right-auto left-0 border-r border-line animate-fade-in",
        className,
      )}
    >
      {open && (
        <div className="flex h-full flex-col">
          <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line pr-2 pl-4">
            <h2 id={titleId} className="min-w-0 flex-1 truncate label-caps text-sm text-text">
              {title}
            </h2>
            <IconButton icon={X} label="Cerrar" size="sm" onClick={onClose} data-dialog-close="" />
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>
          {footer && (
            <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              {footer}
            </footer>
          )}
        </div>
      )}
    </dialog>
  );
}
