/**
 * Dron del puesto de mando.
 *   DronePanel                  → panel de la pestaña "Dron" del incidente (props en ./types).
 *   useSimulatedMissionTicker   → hace volar las misiones SIMULADAS (la página del incidente lo monta una vez).
 */
export type { DronePanelProps } from "./types";
export { DronePanel } from "./DronePanel";
export { useSimulatedMissionTicker } from "./use-mission-ticker";
