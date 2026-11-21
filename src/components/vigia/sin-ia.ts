/**
 * Por qué Vigía está sin IA ahora (puro): la mesa pidió "Vigía sin IA", o la última vuelta con
 * Claude falló y responde con plantillas mientras vuelve a probar. Lo usan el dock de Vigía y
 * la barra de la ficha.
 */
import type { VigiaView } from "@/lib/vigia/types";

export interface SinIA {
  title: string;
  detail: string;
}

export function sinIA(view: Pick<VigiaView, "ai_off" | "last_error"> | null | undefined): SinIA | null {
  if (!view) return null;
  if (view.ai_off) {
    return { title: "Vigía sin IA", detail: "Lo activó la mesa: responde con plantillas, y la fusión y la radio van por reglas." };
  }
  if (view.last_error) {
    return /^Claude falló/.test(view.last_error)
      ? { title: "Vigía sin IA: Claude no responde", detail: `Responde con plantillas y vuelve a probar solo. ${view.last_error}` }
      : { title: "Vigía: falló la última vuelta", detail: view.last_error };
  }
  return null;
}
