/**
 * Selección del motor de IA (solo servidor).
 *  - Con credencial de Anthropic (y sin VIGIA_AI=simulated) → Claude con visión.
 *  - Sin credencial → motor de reglas determinista, siempre rotulado "simulated".
 */
import { aiEngineKind } from "@/lib/config";
import { createClaudeEngine } from "./engine-claude";
import { createSimulatedEngine } from "./engine-simulated";
import type { Engine } from "./types";

export type {
  CommsAnalysisInput,
  Engine,
  FrameImage,
  FusionInput,
  FusionMedia,
  IncidentContext,
  KeyFrameImage,
  MediaAnalysisInput,
} from "./types";

type GlobalWithEngine = typeof globalThis & {
  __vigiaEngine?: Engine;
  __vigiaSimulatedEngine?: Engine;
};

export function getEngine(): Engine {
  const g = globalThis as GlobalWithEngine;
  const kind = aiEngineKind();
  // Se revisa el modo en cada llamada: si cambia la configuración no queda un motor viejo pegado.
  if (!g.__vigiaEngine || g.__vigiaEngine.kind !== kind) {
    g.__vigiaEngine = kind === "claude" ? createClaudeEngine() : getSimulatedEngine();
  }
  return g.__vigiaEngine;
}

/** Motor de reglas; el pipeline lo usa también como respaldo si Claude falla en la fusión. */
export function getSimulatedEngine(): Engine {
  const g = globalThis as GlobalWithEngine;
  g.__vigiaSimulatedEngine ??= createSimulatedEngine();
  return g.__vigiaSimulatedEngine;
}
