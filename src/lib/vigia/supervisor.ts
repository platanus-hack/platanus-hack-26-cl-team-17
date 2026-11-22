/**
 * Escucha continua de Vigía (solo servidor). Un reloj en el proceso revisa cada ~2 s las
 * emergencias activas: si cambió algo (radio, videos, dron, informe), si el OBAC preguntó
 * o si toca el resumen, corre una vuelta del agente. No depende de que haya un navegador
 * abierto. Con varias instancias, un candado del store evita vueltas duplicadas.
 *
 * Arranca en src/instrumentation.ts y, por si acaso, con la primera consulta a Vigía.
 */
import { config } from "@/lib/config";
import { recordServerError } from "@/lib/server/diagnostics";
import { loadFocusPin } from "@/lib/server/focus";
import { getStore } from "@/lib/store";
import { runVigiaTurn } from "./agent";
import { getVigiaState } from "./state-store";

const TICK_MS = 2_000;
const LIST_EVERY_MS = 10_000;
/** Aunque nada cambie, se mira cada tanto (pendientes vencidos, resumen). */
const IDLE_CHECK_MS = 5_000;
/** Solo emergencias activas tocadas en las últimas horas (las viejas de demo no gastan). */
const RECENT_MS = 12 * 3600_000;
/**
 * Vigía se centra en una emergencia a la vez: la fijada en el tablero o, si no hay, la abierta
 * más nueva (mismo criterio que el puente Zello y el puente del dron; ver lib/server/focus.ts).
 */
const MAX_INCIDENTS = 1;
const LOCK_TTL_S = 90;

interface Watch {
  rev: number;
  vigiaRev: number;
  checkedAt: number;
  running: boolean;
}

interface Supervisor {
  timer: ReturnType<typeof setInterval>;
  watches: Map<string, Watch>;
  ids: string[];
  listedAt: number;
  ticking: boolean;
  /** Emergencias que pidieron vuelta inmediata (pregunta del OBAC). */
  wake: Set<string>;
}

type GlobalWithSupervisor = typeof globalThis & {
  __vigiaSupervisor?: Supervisor;
  /** La implementación más reciente del reloj (en desarrollo cada recarga la reemplaza). */
  __vigiaTick?: (sup: Supervisor) => Promise<void>;
};

async function listWatched(): Promise<string[]> {
  const now = Date.now();
  const [incidents, pin] = await Promise.all([getStore().listIncidents({ status: ["active", "controlled"] }), loadFocusPin()]);
  // La fijada a mano se atiende aunque lleve horas sin cambios.
  if (pin && incidents.some((i) => i.id === pin)) return [pin];
  return incidents
    .filter((i) => now - Date.parse(i.updated_at) <= RECENT_MS)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, MAX_INCIDENTS)
    .map((i) => i.id);
}

async function turnWithLock(id: string): Promise<void> {
  const store = getStore();
  if (!(await store.acquireLock(id, "vigia", LOCK_TTL_S))) return;
  try {
    await runVigiaTurn(id);
  } finally {
    await store.releaseLock(id, "vigia").catch(() => undefined);
  }
}

async function tick(sup: Supervisor): Promise<void> {
  if (sup.ticking) return;
  sup.ticking = true;
  try {
    const now = Date.now();
    if (now - sup.listedAt >= LIST_EVERY_MS || sup.ids.length === 0) {
      sup.ids = await listWatched();
      sup.listedAt = now;
      for (const id of sup.watches.keys()) if (!sup.ids.includes(id) && !sup.wake.has(id)) sup.watches.delete(id);
    }
    const store = getStore();
    const ids = [...new Set([...sup.wake, ...sup.ids])];
    for (const id of ids) {
      const w = sup.watches.get(id) ?? { rev: -1, vigiaRev: -1, checkedAt: 0, running: false };
      sup.watches.set(id, w);
      if (w.running) continue;
      const woken = sup.wake.delete(id);
      const rev = await store.getIncidentRev(id);
      if (rev === null) {
        sup.watches.delete(id);
        continue;
      }
      // Preguntas escritas en la mesa de mando: cambian la memoria de Vigía, no el incidente.
      const vigia = woken ? null : await getVigiaState(id);
      const unanswered = vigia ? vigia.questions.some((q) => !q.answered) : true;
      if (!woken && rev === w.rev && !unanswered && now - w.checkedAt < IDLE_CHECK_MS) continue;
      w.rev = rev;
      w.checkedAt = now;
      w.running = true;
      void turnWithLock(id)
        .catch((error: unknown) => {
          console.warn("[vigia] supervisor: vuelta fallida", { id, error: String(error) });
          recordServerError("agente", error, { incidentId: id, context: "Escucha continua: vuelta fallida" });
        })
        .finally(() => {
          w.running = false;
        });
    }
  } catch (error) {
    console.warn("[vigia] supervisor: no pude revisar las emergencias", { error: error instanceof Error ? error.message : String(error) });
    recordServerError("agente", error, { context: "Escucha continua: no pude revisar las emergencias" });
  } finally {
    sup.ticking = false;
  }
}

/** Arranca (o reinicia tras recargar el código en desarrollo) la escucha continua. Idempotente. */
export function ensureVigiaSupervisor(): void {
  if (!config.vigiaAgent) return;
  const g = globalThis as GlobalWithSupervisor;
  // Un solo reloj por proceso; siempre llama a la implementación cargada más reciente
  // (en desarrollo cada ruta puede traer su propia copia del módulo).
  g.__vigiaTick = tick;
  if (g.__vigiaSupervisor) return;
  const sup: Supervisor = {
    timer: setInterval(() => void (g.__vigiaTick ?? tick)(sup), TICK_MS),
    watches: new Map(),
    ids: [],
    listedAt: 0,
    ticking: false,
    wake: new Set(),
  };
  sup.timer.unref?.();
  g.__vigiaSupervisor = sup;
  console.info("[vigia] escucha continua activa", { every_ms: TICK_MS, model: config.vigiaAgentModel });
}

/** Cambió la emergencia en foco: la próxima vuelta del reloj vuelve a leer cuál atender. */
export function refreshVigiaWatch(): void {
  const sup = (globalThis as GlobalWithSupervisor).__vigiaSupervisor;
  if (sup) sup.listedAt = 0;
}

/** Pide una vuelta lo antes posible (el OBAC escribió). */
export function wakeVigia(incidentId: string): void {
  ensureVigiaSupervisor();
  const sup = (globalThis as GlobalWithSupervisor).__vigiaSupervisor;
  if (!sup) return;
  sup.wake.add(incidentId);
  void tick(sup);
}
