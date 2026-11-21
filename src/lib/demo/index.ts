/**
 * Datos de demostración y simulacro en vivo. Solo servidor.
 *
 *   seedDemo()                       → siembra las vitrinas (idempotente) y devuelve la principal.
 *   runScenarioStep(incidentId, n)   → ejecuta el paso n del simulacro (null + 0 lo inicia).
 *   ensureLocalSeed()                → en modo local sin incidentes, siembra la demo.
 *
 * Todo lo que crea queda rotulado: origin "demo", medios source "demo" (o "drone" ligados
 * a una misión simulada), análisis con motor "simulated" y pósters con marca de agua.
 */
import { after } from "next/server";
import type { ScenarioStepResponse } from "@/lib/contract";
import { processMedia, requestCommsAnalysis, requestFusion } from "@/lib/ai/pipeline";
import { getFiles, getStore } from "@/lib/store";
import { runScenarioStepCore, seedDemoWith } from "./core";
import type { DemoDeps } from "./types";

function deps(): DemoDeps {
  return {
    store: getStore(),
    files: getFiles(),
    pipeline: { processMedia, requestFusion, requestCommsAnalysis },
    now: Date.now,
    defer: (task) => after(task),
  };
}

type GlobalWithSeed = typeof globalThis & {
  __vigiaDemoSeed?: Promise<{ incident_id: string }>;
  __vigiaLocalSeed?: Promise<void>;
};

/** Una sola siembra a la vez por proceso: dos clics seguidos (o dos pestañas) no duplican. */
export function seedDemo(): Promise<{ incident_id: string }> {
  const g = globalThis as GlobalWithSeed;
  if (!g.__vigiaDemoSeed) {
    g.__vigiaDemoSeed = seedDemoWith(deps()).finally(() => {
      g.__vigiaDemoSeed = undefined;
    });
  }
  return g.__vigiaDemoSeed;
}

export function runScenarioStep(incidentId: string | null, step: number): Promise<ScenarioStepResponse> {
  return runScenarioStepCore(deps(), incidentId, step);
}

/**
 * Nunca lanza: si la siembra falla, el listado debe seguir funcionando (vacío).
 * Siembra a través de `seedDemo` para compartir su promesa y no sembrar dos veces en paralelo.
 */
export function ensureLocalSeed(): Promise<void> {
  const g = globalThis as GlobalWithSeed;
  if (!g.__vigiaLocalSeed) {
    g.__vigiaLocalSeed = (async () => {
      const store = getStore();
      if (store.kind !== "local") return;
      if ((await store.listIncidents()).length > 0) return;
      await seedDemo();
    })()
      .catch((err) => {
        console.error("[demo] no se pudo sembrar la demo local:", err);
      })
      .finally(() => {
        g.__vigiaLocalSeed = undefined;
      });
  }
  return g.__vigiaLocalSeed;
}
