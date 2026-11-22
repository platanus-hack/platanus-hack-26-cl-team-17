"use client";

import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";
import { cn } from "@/lib/cn";

/** Clave en localStorage del modo de color elegido ("oscuro" | "claro"). */
export const MODO_KEY = "vigia-modo";

/**
 * Script que corre antes de pintar (en <head>): aplica el modo guardado para que no parpadee.
 * Sin preferencia guardada, sigue al sistema.
 */
export const MODO_SCRIPT = `try{var m=localStorage.getItem("${MODO_KEY}");if(m!=="claro"&&m!=="oscuro")m=matchMedia("(prefers-color-scheme: dark)").matches?"oscuro":"claro";document.documentElement.dataset.modo=m}catch(e){}`;

function subscribe(cb: () => void) {
  const obs = new MutationObserver(cb);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-modo"] });
  return () => obs.disconnect();
}

const getModo = () => document.documentElement.dataset.modo === "oscuro";

/** Botón para cambiar entre modo claro y modo oscuro (carbón y rojo, como la portada). */
export function ThemeToggle({ className }: { className?: string }) {
  const oscuro = useSyncExternalStore(subscribe, getModo, () => false);
  const toggle = () => {
    const modo = oscuro ? "claro" : "oscuro";
    document.documentElement.dataset.modo = modo;
    try {
      localStorage.setItem(MODO_KEY, modo);
    } catch {
      /* sin almacenamiento: el cambio dura hasta recargar */
    }
  };
  const Icon = oscuro ? Sun : Moon;
  const label = oscuro ? "Cambiar a modo claro" : "Cambiar a modo oscuro";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      className={cn(
        "grid size-9 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-text",
        className,
      )}
    >
      <Icon className="size-[18px]" aria-hidden="true" />
    </button>
  );
}
