"use client";

import {
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
} from "react";
import { TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "./Button";
import { IconButton } from "./IconButton";

const FOCUSABLE = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "audio[controls]",
  "video[controls]",
  "summary",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Elementos enfocables y visibles dentro de `root`, en orden de documento. */
export function getFocusable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.tabIndex >= 0 && el.getClientRects().length > 0 && !el.closest("[inert]"),
  );
}

// Bloqueo de scroll compartido: varios modales abiertos a la vez no deben pisarse.
let scrollLocks = 0;
let previousOverflow = "";

function lockScroll() {
  if (scrollLocks === 0) {
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  scrollLocks += 1;
}

function unlockScroll() {
  scrollLocks = Math.max(0, scrollLocks - 1);
  if (scrollLocks === 0) document.body.style.overflow = previousOverflow;
}

/** Opciones de `useModalDialog`. */
export interface UseModalDialogOptions {
  open: boolean;
  onClose: () => void;
  /** Esc y clic en el fondo cierran (por defecto true). */
  dismissible?: boolean;
  /** Elemento que recibe el foco al abrir. Si falta: `[data-autofocus]`, luego el primer enfocable (salvo el botón cerrar), luego el diálogo. */
  initialFocusRef?: RefObject<HTMLElement | null>;
}

/** Props que `useModalDialog` entrega para esparcir sobre un `<dialog>`. */
export interface ModalDialogBindings {
  ref: RefObject<HTMLDialogElement | null>;
  tabIndex: -1;
  onCancel: (event: SyntheticEvent<HTMLDialogElement>) => void;
  onClose: (event: SyntheticEvent<HTMLDialogElement>) => void;
  onPointerDown: (event: PointerEvent<HTMLDialogElement>) => void;
  onClick: (event: MouseEvent<HTMLDialogElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDialogElement>) => void;
}

/** Controla un `<dialog>` nativo modal: showModal/close según `open`, Esc, clic en fondo, trampa de foco, restauración de foco y bloqueo de scroll. */
export function useModalDialog({
  open,
  onClose,
  dismissible = true,
  initialFocusRef,
}: UseModalDialogOptions): ModalDialogBindings {
  const ref = useRef<HTMLDialogElement | null>(null);
  const pressedOnBackdrop = useRef(false);

  const focusInitial = useEffectEvent((el: HTMLDialogElement) => {
    const target =
      initialFocusRef?.current ??
      el.querySelector<HTMLElement>("[data-autofocus]") ??
      getFocusable(el).find((node) => !node.hasAttribute("data-dialog-close")) ??
      el;
    target.focus({ preventScroll: target === el });
  });

  useEffect(() => {
    const el = ref.current;
    if (!open || !el) return;
    const previous = document.activeElement;
    if (!el.open) el.showModal();
    focusInitial(el);
    lockScroll();
    return () => {
      unlockScroll();
      if (el.open) el.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open]);

  return {
    ref,
    tabIndex: -1,
    onCancel: (event) => {
      if (event.target !== event.currentTarget) return;
      // El estado lo controla el padre: nunca dejamos que el navegador cierre por su cuenta.
      event.preventDefault();
      if (dismissible) onClose();
    },
    onClose: (event) => {
      // `close` llega asíncrono: si ya se reabrió (StrictMode) o lo cerramos nosotros, se ignora.
      if (event.target !== event.currentTarget || !open || event.currentTarget.open) return;
      // Cierre nativo inesperado (p. ej. form method="dialog" o Esc repetido sin cancel cancelable).
      if (dismissible) onClose();
      else event.currentTarget.showModal();
    },
    onPointerDown: (event) => {
      pressedOnBackdrop.current = event.target === event.currentTarget;
    },
    onClick: (event) => {
      // Solo cuenta si presionó y soltó sobre el fondo (evita cerrar al arrastrar una selección de texto).
      const onBackdrop = event.target === event.currentTarget && pressedOnBackdrop.current;
      pressedOnBackdrop.current = false;
      if (onBackdrop && dismissible) onClose();
    },
    onKeyDown: (event) => {
      if (event.key !== "Tab") return;
      const el = event.currentTarget;
      // Diálogos anidados: el evento burbujea por el árbol de React; lo maneja solo el más interno.
      if ((event.target as Element).closest("dialog") !== el) return;
      const items = getFocusable(el);
      if (items.length === 0) {
        event.preventDefault();
        el.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const outside = active === el || !el.contains(active);
      if (event.shiftKey && (active === first || outside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || outside)) {
        event.preventDefault();
        first.focus();
      }
    },
  };
}

/** Props de `Dialog`. */
export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl" | "full";
  footer?: ReactNode;
  hideClose?: boolean;
  /** Esc y clic en el fondo cierran (por defecto true). Con false, Esc se bloquea. */
  dismissible?: boolean;
  /** Elemento que recibe el foco al abrir (alternativa: atributo `data-autofocus` en un hijo). */
  initialFocusRef?: RefObject<HTMLElement | null>;
  bodyClassName?: string;
  className?: string;
  children?: ReactNode;
}

const sizeClass: Record<NonNullable<DialogProps["size"]>, string> = {
  sm: "w-[calc(100%-2rem)] max-w-[400px] max-h-[calc(100dvh-2rem)]",
  md: "w-[calc(100%-2rem)] max-w-[560px] max-h-[calc(100dvh-2rem)]",
  lg: "w-[calc(100%-2rem)] max-w-[760px] max-h-[calc(100dvh-2rem)]",
  xl: "w-[calc(100%-2rem)] max-w-[1040px] max-h-[calc(100dvh-2rem)]",
  full: "w-[96vw] max-w-[96vw] h-[92dvh] max-h-[92dvh]",
};

/** Diálogo modal sobre `<dialog>` nativo, con trampa de foco, Esc y clic en el fondo para cerrar. */
export function Dialog({
  open,
  onClose,
  title,
  description,
  size = "md",
  footer,
  hideClose = false,
  dismissible = true,
  initialFocusRef,
  bodyClassName,
  className,
  children,
}: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const bindings = useModalDialog({ open, onClose, dismissible, initialFocusRef });

  return (
    <dialog
      {...bindings}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      className={cn(
        "m-auto overflow-hidden rounded-2xl border border-line bg-surface p-0 text-text",
        "focus-visible:outline-none",
        sizeClass[size],
        className,
      )}
    >
      {open && (
        <div
          className={cn(
            "flex animate-enter flex-col",
            size === "full" ? "h-full" : "max-h-[calc(100dvh-2rem)]",
          )}
        >
          <header className="flex shrink-0 items-start gap-3 border-b border-line py-2 pr-2 pl-4">
            <div className="min-w-0 flex-1 py-1">
              <h2 id={titleId} className="label-caps text-sm text-text">
                {title}
              </h2>
              {description && (
                <div id={descriptionId} className="mt-1 text-sm text-muted">
                  {description}
                </div>
              )}
            </div>
            {!hideClose && (
              <IconButton icon={X} label="Cerrar" size="sm" onClick={onClose} data-dialog-close="" />
            )}
          </header>
          <div className={cn("min-h-0 flex-1 overflow-y-auto px-4 py-4", bodyClassName)}>{children}</div>
          {footer && (
            <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-3">
              {footer}
            </footer>
          )}
        </div>
      )}
    </dialog>
  );
}

/** Props de `ConfirmDialog`. */
export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  /** Acción confirmada. Si devuelve una promesa, el diálogo muestra carga hasta que se resuelva; cerrar queda a cargo del padre. */
  onConfirm: () => void | Promise<void>;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  loading?: boolean;
}

/** Diálogo de confirmación con Cancelar/Confirmar; el foco inicial queda en Cancelar. */
export function ConfirmDialog(props: ConfirmDialogProps) {
  // Montar solo mientras está abierto reinicia el estado interno (carga, error) en cada apertura.
  if (!props.open) return null;
  return <ConfirmDialogOpen {...props} />;
}

function ConfirmDialogOpen({
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = "Confirmar",
  cancelLabel = "Cancelar",
  danger = false,
  loading = false,
}: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const busy = loading || pending;

  const close = () => {
    if (!busy) onClose();
  };

  const confirm = async () => {
    if (busy) return;
    setFailed(false);
    setPending(true);
    try {
      await onConfirm();
    } catch (error) {
      console.error(error);
      setFailed(true);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open
      onClose={close}
      title={title}
      size="sm"
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={busy} data-autofocus="">
            {cancelLabel}
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            icon={danger ? TriangleAlert : undefined}
            loading={busy}
            onClick={confirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {description && <div className="text-sm text-text">{description}</div>}
      {failed && (
        <p role="alert" className={cn("flex items-start gap-2 text-sm text-critical", description ? "mt-3" : undefined)}>
          <TriangleAlert aria-hidden="true" size={16} className="mt-0.5 shrink-0" />
          No se pudo completar la acción. Intenta de nuevo.
        </p>
      )}
      {!description && !failed && <p className="text-sm text-muted">¿Quieres continuar?</p>}
    </Dialog>
  );
}
