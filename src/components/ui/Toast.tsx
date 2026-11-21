"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CircleCheck, Info, Siren, TriangleAlert, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "./Button";
import { IconButton } from "./IconButton";
import { toneBorder, toneText, type Tone } from "./tone";

/** Datos de un aviso para `toast()`. */
export interface ToastInput {
  title: string;
  description?: ReactNode;
  tone?: Tone;
  /** Ícono; por defecto según tono (crítico, advertencia, ok, info). */
  icon?: LucideIcon;
  /** Duración en ms; 0 = permanece hasta cerrarlo. Por defecto 6000 (crítico: 0). */
  duration?: number;
  action?: { label: string; onClick: () => void };
  /** Id estable: un aviso con el mismo id reemplaza al anterior. */
  id?: string;
}

/** API de avisos que entrega `useToast()`. */
export interface ToastApi {
  toast: (t: ToastInput) => string;
  dismiss: (id: string) => void;
}

/** Props de `ToastProvider`. */
export interface ToastProviderProps {
  children?: ReactNode;
}

interface ToastRecord {
  id: string;
  /** Cambia en cada reemplazo para reiniciar el temporizador y la animación. */
  version: number;
  title: string;
  description?: ReactNode;
  tone: Tone;
  icon?: LucideIcon;
  duration: number;
  action?: { label: string; onClick: () => void };
}

const MAX_VISIBLE = 4;
const DEFAULT_DURATION = 6000;

const defaultIcon: Partial<Record<Tone, LucideIcon>> = {
  critical: Siren,
  warning: TriangleAlert,
  ok: CircleCheck,
  info: Info,
};

const ToastContext = createContext<ToastApi | null>(null);

const noopApi: ToastApi = {
  toast: (t) => t.id ?? "",
  dismiss: () => {},
};

let warnedMissingProvider = false;

/** Recorta a MAX_VISIBLE descartando primero los más antiguos no críticos (un aviso crítico no se pierde en silencio). */
function trim(list: ToastRecord[]): ToastRecord[] {
  const next = [...list];
  while (next.length > MAX_VISIBLE) {
    const index = next.findIndex((t) => t.tone !== "critical");
    next.splice(index >= 0 ? index : 0, 1);
  }
  return next;
}

/** Proveedor de avisos: expone `useToast()` y dibuja la región viva fija donde aparecen. */
export function ToastProvider({ children }: ToastProviderProps) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((input: ToastInput) => {
    counter.current += 1;
    const seq = counter.current;
    const id = input.id ?? `toast-${seq}`;
    const tone = input.tone ?? "neutral";
    const record: ToastRecord = {
      id,
      version: seq,
      title: input.title,
      description: input.description,
      tone,
      icon: input.icon ?? defaultIcon[tone],
      duration: Math.max(0, input.duration ?? (tone === "critical" ? 0 : DEFAULT_DURATION)),
      action: input.action,
    };
    setToasts((prev) => {
      const index = prev.findIndex((t) => t.id === id);
      if (index >= 0) return prev.map((t, i) => (i === index ? record : t));
      return trim([...prev, record]);
    });
    return id;
  }, []);

  const api = useMemo<ToastApi>(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        role="region"
        aria-label="Notificaciones"
        aria-live="polite"
        aria-relevant="additions text"
        className="pointer-events-none fixed inset-x-0 top-0 z-[60] flex flex-col gap-2 p-3 sm:left-auto sm:w-96 sm:p-4"
      >
        {[...toasts].reverse().map((t) => (
          <ToastItem key={`${t.id}:${t.version}`} toast={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

interface ToastItemProps {
  toast: ToastRecord;
  onDismiss: (id: string) => void;
}

function ToastItem({ toast: t, onDismiss }: ToastItemProps) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef(t.duration);
  const critical = t.tone === "critical";
  const Icon = t.icon;

  useEffect(() => {
    if (t.duration <= 0 || paused) return;
    const startedAt = Date.now();
    const timer = window.setTimeout(() => onDismiss(t.id), Math.max(0, remaining.current));
    return () => {
      window.clearTimeout(timer);
      remaining.current -= Date.now() - startedAt;
    };
  }, [paused, t.duration, t.id, onDismiss]);

  return (
    <div
      role={critical ? "alert" : undefined}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) setPaused(false);
      }}
      className="pointer-events-auto animate-enter overflow-hidden rounded-2xl bg-surface"
    >
      <div
        className={cn(
          "flex items-start gap-3 rounded-2xl border p-3",
          critical ? "border-critical bg-critical-soft" : toneBorder[t.tone],
        )}
      >
        {critical && (
          <span aria-hidden="true" className="mt-1.5 size-2 shrink-0 rounded-full bg-critical animate-pulse-critical" />
        )}
        {Icon && <Icon aria-hidden="true" size={18} className={cn("mt-px shrink-0", toneText[t.tone])} />}
        <div className="min-w-0 flex-1">
          <p className={cn("line-clamp-2 text-sm font-semibold break-words", critical ? "text-critical" : "text-text")}>
            {t.title}
          </p>
          {t.description && <div className="mt-0.5 line-clamp-3 text-sm break-words text-muted">{t.description}</div>}
          {t.action && (
            <Button
              size="sm"
              variant={critical ? "danger" : "secondary"}
              className="mt-2"
              onClick={() => {
                t.action?.onClick();
                onDismiss(t.id);
              }}
            >
              {t.action.label}
            </Button>
          )}
        </div>
        <IconButton
          icon={X}
          label="Cerrar notificación"
          size="sm"
          className="-mt-1 -mr-1"
          onClick={() => onDismiss(t.id)}
        />
      </div>
    </div>
  );
}

/** Acceso a los avisos; fuera de `ToastProvider` devuelve funciones vacías (y avisa una vez en desarrollo). */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);

  useEffect(() => {
    if (ctx || warnedMissingProvider || process.env.NODE_ENV === "production") return;
    warnedMissingProvider = true;
    console.warn("useToast() se usó fuera de <ToastProvider>: los avisos no se mostrarán.");
  }, [ctx]);

  return ctx ?? noopApi;
}
