/** Simulacro en vivo del puesto de mando: proveedor, hook, chip y ejecutor puro. */
export { ScenarioProvider, useScenario, type ScenarioState } from "./ScenarioProvider";
export { ScenarioChip, scenarioVisible, type ScenarioChipProps } from "./ScenarioChip";
export {
  runScenario,
  abortableSleep,
  DEFAULT_BACKOFF_MS,
  DEFAULT_MAX_ATTEMPTS,
  type ScenarioDeps,
  type ScenarioProgress,
  type ScenarioRunOptions,
  type ScenarioRunResult,
} from "./scenario-core";
