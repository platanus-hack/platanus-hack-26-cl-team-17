/**
 * Salida de Vigía: cada mensaje nuevo se avisa a quien escuche en este proceso (p. ej. un
 * puente que corra dentro del servidor). Los procesos aparte leen GET …/vigia/salida.
 */
import type { VigiaUtterance } from "./types";

type Listener = (u: VigiaUtterance) => void;
type GlobalWithOutbox = typeof globalThis & { __vigiaOutbox?: Set<Listener> };

function listeners(): Set<Listener> {
  const g = globalThis as GlobalWithOutbox;
  g.__vigiaOutbox ??= new Set();
  return g.__vigiaOutbox;
}

/** Se suscribe a los mensajes nuevos de Vigía (de todas las emergencias). Devuelve cómo desuscribirse. */
export function onVigiaUtterance(listener: Listener): () => void {
  listeners().add(listener);
  return () => listeners().delete(listener);
}

export function emitUtterances(list: VigiaUtterance[]): void {
  for (const u of list) {
    for (const l of listeners()) {
      try {
        l(u);
      } catch (error) {
        console.warn("[vigia] un suscriptor de la salida falló", { error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
}
