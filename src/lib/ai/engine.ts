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

// Caché a nivel de módulo (no en globalThis): al editar el código en desarrollo el
// módulo se recarga y el motor se vuelve a crear con las funciones nuevas. Los
// motores no guardan estado; el cliente de Anthropic sí se comparte en client.ts.
let engine: Engine | null = null;
let simulatedEngine: Engine | null = null;

export function getEngine(): Engine {
  const kind = aiEngineKind();
  // Se revisa el modo en cada llamada: si cambia la configuración no queda un motor viejo pegado.
  if (!engine || engine.kind !== kind) {
    engine = kind === "claude" ? createClaudeEngine() : getSimulatedEngine();
  }
  return engine;
}

/** Motor de reglas; el pipeline lo usa también como respaldo si Claude falla en la fusión. */
export function getSimulatedEngine(): Engine {
  simulatedEngine ??= createSimulatedEngine();
  return simulatedEngine;
}
