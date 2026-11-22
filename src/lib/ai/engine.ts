/**
 * Selección del motor de IA (solo servidor).
 *  - Con credencial de Anthropic → Claude con visión.
 *  - Sin credencial → null: no hay análisis de IA (el pipeline lo deja dicho en cada medio).
 *  - Con VIGIA_DETECTOR_URL y el detector sano, Claude razona sobre las detecciones YOLO
 *    y un cuadro anotado en vez de ver todos los fotogramas (engine-detector.ts).
 */
import { aiEngineKind } from "@/lib/config";
import { createClaudeEngine } from "./engine-claude";
import { createDetectorEngine } from "./engine-detector";
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

/** Motor de Claude, o null si no hay credencial de Anthropic. */
export function getEngine(): Engine | null {
  // Se revisa el modo en cada llamada: si se quita la credencial no queda un motor viejo pegado.
  if (aiEngineKind() !== "claude") return null;
  // Claude va envuelto en el detector YOLO: sin detector sano se comporta igual que antes.
  engine ??= createDetectorEngine(createClaudeEngine());
  return engine;
}
