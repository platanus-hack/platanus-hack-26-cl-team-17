/**
 * Selección del motor de IA (solo servidor).
 *  - Con credencial de Anthropic (y sin VIGIA_AI=simulated) → Claude con visión.
 *  - Sin credencial → motor de reglas determinista, siempre rotulado "simulated".
 *  - Con VIGIA_DETECTOR_URL y el detector sano, Claude razona sobre las detecciones YOLO
 *    y un cuadro anotado en vez de ver todos los fotogramas (engine-detector.ts).
 */
import { aiEngineKind } from "@/lib/config";
import { createClaudeEngine } from "./engine-claude";
import { createDetectorEngine } from "./engine-detector";
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
    // Claude va envuelto en el detector YOLO: sin detector sano se comporta igual que antes.
    engine = kind === "claude" ? createDetectorEngine(createClaudeEngine()) : getSimulatedEngine();
  }
  return engine;
}

/** Motor de reglas; el pipeline lo usa también como respaldo si Claude falla en la fusión. */
export function getSimulatedEngine(): Engine {
  simulatedEngine ??= createSimulatedEngine();
  return simulatedEngine;
}
