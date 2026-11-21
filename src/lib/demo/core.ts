/**
 * Lógica de siembra con dependencias inyectadas (probable sin Next ni pipeline).
 * `index.ts` la conecta al store real, al pipeline y a `after()`.
 */
import type { ScenarioStepResponse } from "@/lib/contract";
import type { Incident } from "@/lib/domain";
import { SCENARIO } from "./data-scenario";
import { SHOWCASE_A } from "./data-showcase-a";
import { SHOWCASE_B } from "./data-showcase-b";
import { runScenarioStepWith } from "./scenario";
import { seedShowcase } from "./seed";
import type { DemoDeps, ShowcaseSpec } from "./types";

/** Vitrinas en orden de siembra; la primera es la que se abre al cargar la demo. */
export const SHOWCASES: readonly ShowcaseSpec[] = [SHOWCASE_A, SHOWCASE_B];

const INCOMPLETE_SUFFIX = " (siembra incompleta)";

/**
 * Siembra las vitrinas que falten. Una vitrina ya sembrada (mismo título, origin "demo"
 * y con informe) no se duplica; una que quedó a medias (sin informe) se cierra y se rehace.
 */
export async function seedDemoWith(deps: DemoDeps): Promise<{ incident_id: string }> {
  const existing = (await deps.store.listIncidents()).filter((i) => i.origin === "demo");
  const ids: string[] = [];
  for (const spec of SHOWCASES) {
    const same = existing.filter((i) => i.title === spec.title);
    const complete = same.find((i) => i.situation !== null);
    if (complete) {
      ids.push(complete.id);
      continue;
    }
    for (const broken of same) {
      await deps.store.updateIncident(broken.id, {
        status: "closed",
        title: `${spec.title}${INCOMPLETE_SUFFIX}`.slice(0, 140),
      });
    }
    const seeded: Incident = await seedShowcase(deps, spec);
    ids.push(seeded.id);
  }
  return { incident_id: ids[0] };
}

/** Modo local sin incidentes → siembra la demo para que la plataforma no se vea vacía. */
export async function ensureLocalSeedWith(deps: DemoDeps): Promise<void> {
  if (deps.store.kind !== "local") return;
  const incidents = await deps.store.listIncidents();
  if (incidents.length > 0) return;
  await seedDemoWith(deps);
}

export function runScenarioStepCore(
  deps: DemoDeps,
  incidentId: string | null,
  step: number,
): Promise<ScenarioStepResponse> {
  return runScenarioStepWith(deps, SCENARIO, incidentId, step);
}
