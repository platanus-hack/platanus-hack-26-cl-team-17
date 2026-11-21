"use client";

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, Database, FlaskConical, Play, Square } from "lucide-react";
import { Button, Spinner, useToast } from "@/components/ui";
import { useScenario } from "@/components/mando/scenario";
import { api, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/cn";

/** Carga los incidentes de demostración con aviso; devuelve `seed` y si está cargando. */
export function useSeedDemo(onSeeded?: () => void): { seed: () => Promise<void>; seeding: boolean } {
  const { toast } = useToast();
  const [seeding, setSeeding] = useState(false);
  const busy = useRef(false);

  const seed = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setSeeding(true);
    try {
      await api.demo.seed();
      toast({
        title: "Incidentes de demostración cargados",
        description: "Son datos ficticios, rotulados como DEMO.",
        tone: "info",
        icon: FlaskConical,
      });
      onSeeded?.();
    } catch (err) {
      toast({ title: "No se pudieron cargar los datos de demostración", description: errorMessage(err), tone: "critical" });
    } finally {
      busy.current = false;
      setSeeding(false);
    }
  }, [onSeeded, toast]);

  return { seed, seeding };
}

/** Inicia o detiene el simulacro en vivo, avisando si no se pudo iniciar. */
export function useToggleScenario(): { toggle: () => void; running: boolean } {
  const scenario = useScenario();
  const { toast } = useToast();
  const { running, start, stop } = scenario;
  const toggle = useCallback(() => {
    if (running) {
      stop();
      return;
    }
    start().catch((err: unknown) => {
      toast({ title: "No se pudo iniciar el simulacro", description: errorMessage(err), tone: "critical" });
    });
  }, [running, start, stop, toast]);
  return { toggle, running };
}

/** Props de `DemoMenu`. */
export interface DemoMenuProps {
  /** Se llama después de cargar los incidentes de demostración. */
  onSeeded?: () => void;
}

/** Menú "Demostración": cargar incidentes ficticios e iniciar/detener el simulacro en vivo. */
export function DemoMenu({ onSeeded }: DemoMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const { seed, seeding } = useSeedDemo(onSeeded);
  const { toggle, running } = useToggleScenario();

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  // Al abrir, el foco va al primer elemento del menú.
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
  }, [open]);

  // Clic o toque fuera cierra sin robar el foco.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [],
    );
    const idx = items.indexOf(document.activeElement as HTMLElement);
    const focusAt = (n: number) => items[(n + items.length) % items.length]?.focus();
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        focusAt(idx + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        focusAt(idx - 1);
        break;
      case "Home":
        e.preventDefault();
        focusAt(0);
        break;
      case "End":
        e.preventDefault();
        focusAt(items.length - 1);
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        close(true);
        break;
      case "Tab":
        setOpen(false);
        break;
    }
  };

  const onTriggerKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" && !open) {
      e.preventDefault();
      setOpen(true);
    }
  };

  const itemClass =
    "flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-text outline-none hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-60";

  return (
    <div ref={rootRef} className="relative">
      <Button
        ref={triggerRef}
        icon={FlaskConical}
        iconRight={ChevronDown}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onTriggerKeyDown}
        title="Datos ficticios para demostración"
      >
        <span className="max-sm:sr-only">Demostración</span>
      </Button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="Demostración"
          onKeyDown={onMenuKeyDown}
          className="animate-fade-in absolute right-0 top-full z-50 mt-1 w-72 rounded-lg border border-line-strong bg-surface p-1.5"
        >
          <button
            type="button"
            role="menuitem"
            className={itemClass}
            disabled={seeding}
            onClick={() => {
              close(true);
              void seed();
            }}
          >
            {seeding ? <Spinner size="xs" /> : <Database aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-info" />}
            <span>Cargar incidentes de demostración</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={cn(itemClass, running && "text-warning")}
            onClick={() => {
              close(true);
              toggle();
            }}
          >
            {running ? (
              <Square aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            ) : (
              <Play aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
            )}
            <span>{running ? "Detener simulacro" : "Iniciar simulacro en vivo"}</span>
          </button>
          <p className="mt-1 border-t border-line px-2.5 pb-1 pt-2 text-xs text-muted">
            Datos ficticios, rotulados como DEMO
          </p>
        </div>
      )}
    </div>
  );
}
