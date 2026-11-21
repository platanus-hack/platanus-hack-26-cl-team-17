/**
 * Ejecutor puro del simulacro: pide los pasos al servidor uno a uno, respeta el `wait_s`
 * de cada respuesta, reintenta pasos fallidos con espera creciente y se cancela con un
 * AbortSignal. Sin React ni red: las dependencias se inyectan (y se prueban con dobles).
 */
import type { ScenarioStepRequest, ScenarioStepResponse } from "@/lib/contract";

/** Avance informado tras ejecutar un paso (`step` es 1-based: el último paso ejecutado). */
export interface ScenarioProgress {
  incidentId: string;
  step: number;
  total: number;
  label: string;
  done: boolean;
}

/** Dependencias inyectables del ejecutor. */
export interface ScenarioDeps {
  callStep: (req: ScenarioStepRequest, signal: AbortSignal) => Promise<ScenarioStepResponse>;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  onProgress: (p: ScenarioProgress) => void;
  onStarted: (incidentId: string) => void;
}

/** Opciones del ejecutor: intentos por paso (3), esperas entre intentos (1,5 s y 3 s) y filtro de errores reintentables. */
export interface ScenarioRunOptions {
  maxAttempts?: number;
  backoffMs?: number[];
  /** false → el error no se reintenta (p. ej. 401/404). Por defecto todo se reintenta. */
  shouldRetry?: (err: unknown) => boolean;
}

/** Resultado del simulacro: terminó, falló (con el último error) o se canceló. */
export type ScenarioRunResult = { ok: true } | { ok: false; error: unknown } | { ok: false; aborted: true };

/** Intentos por paso por defecto. */
export const DEFAULT_MAX_ATTEMPTS = 3;
/** Esperas por defecto entre intentos de un mismo paso (ms). */
export const DEFAULT_BACKOFF_MS: readonly number[] = [1500, 3000];

function abortError(): DOMException {
  return new DOMException("Operación cancelada.", "AbortError");
}

/** Espera `ms` milisegundos; rechaza con AbortError si `signal` se cancela antes (o ya lo estaba). */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

class AbortedRun extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
}

/** Ejecuta el simulacro completo desde el paso 0 hasta `done`; nunca lanza. */
export async function runScenario(
  deps: ScenarioDeps,
  signal: AbortSignal,
  opts?: ScenarioRunOptions,
): Promise<ScenarioRunResult> {
  const maxAttempts = Math.max(1, Math.floor(opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
  const backoff = opts?.backoffMs ?? DEFAULT_BACKOFF_MS;
  const shouldRetry = opts?.shouldRetry ?? (() => true);

  const checkAborted = () => {
    if (signal.aborted) throw new AbortedRun();
  };

  const callWithRetry = async (req: ScenarioStepRequest): Promise<ScenarioStepResponse> => {
    for (let attempt = 1; ; attempt++) {
      checkAborted();
      try {
        const res = await deps.callStep(req, signal);
        checkAborted();
        return res;
      } catch (err) {
        checkAborted();
        if (attempt >= maxAttempts || !shouldRetry(err)) throw err;
        const wait = backoff.length ? backoff[Math.min(attempt - 1, backoff.length - 1)] : 0;
        await deps.sleep(wait, signal);
      }
    }
  };

  let req: ScenarioStepRequest = { incident_id: null, step: 0 };
  let started = false;
  try {
    for (;;) {
      const res = await callWithRetry(req);
      if (!started) {
        started = true;
        deps.onStarted(res.incident_id);
      }
      deps.onProgress({
        incidentId: res.incident_id,
        step: req.step + 1,
        total: res.total_steps,
        label: res.label,
        done: res.done,
      });
      if (res.done) return { ok: true };
      // Defensa ante un guion que no avanza: evita un ciclo infinito contra el servidor.
      if (!Number.isFinite(res.next_step) || res.next_step <= req.step) {
        return { ok: false, error: new Error("El simulacro no avanzó al paso siguiente.") };
      }
      const waitMs = Number.isFinite(res.wait_s) ? Math.max(0, res.wait_s) * 1000 : 0;
      await deps.sleep(waitMs, signal);
      checkAborted();
      req = { incident_id: res.incident_id, step: res.next_step };
    }
  } catch (err) {
    if (signal.aborted || err instanceof AbortedRun) return { ok: false, aborted: true };
    return { ok: false, error: err };
  }
}
