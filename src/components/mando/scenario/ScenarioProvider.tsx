"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { api, errorMessage, isApiClientError } from "@/lib/client/api";
import { abortableSleep, runScenario } from "./scenario-core";
import { ScenarioChip } from "./ScenarioChip";

/** Estado público del simulacro en vivo y sus acciones. */
export interface ScenarioState {
  running: boolean;
  incidentId: string | null;
  /** Índice 1-based del último paso ejecutado (0 = aún ninguno). */
  step: number;
  total: number | null;
  label: string | null;
  error: string | null;
  finished: boolean;
  /** Inicia un simulacro nuevo (no-op si ya corre). Resuelve al crearse el incidente o al fallar el inicio (ver `error`). */
  start: () => Promise<void>;
  /** Detiene el simulacro, cancela esperas y llamadas en curso, y limpia el estado. */
  stop: () => void;
  /** Cierra el aviso de término o de error (no detiene un simulacro en curso). */
  dismiss: () => void;
}

type ScenarioData = Omit<ScenarioState, "start" | "stop" | "dismiss">;

const IDLE: ScenarioData = {
  running: false,
  incidentId: null,
  step: 0,
  total: null,
  label: null,
  error: null,
  finished: false,
};

const INERT: ScenarioState = {
  ...IDLE,
  start: () => Promise.reject(new Error("Simulacro no disponible")),
  stop: () => {},
  dismiss: () => {},
};

const ScenarioContext = createContext<ScenarioState | null>(null);

/** Tiempo que el chip "Simulacro terminado" queda visible antes de ocultarse solo. */
const FINISHED_HIDE_MS = 8000;

/** Los errores 4xx (salvo 408/429) no mejoran al reintentar; red, 5xx y límites sí. */
function isRetryable(err: unknown): boolean {
  if (!isApiClientError(err)) return true;
  if (err.code === "aborted") return false;
  if (err.status >= 400 && err.status < 500) return err.status === 408 || err.status === 429;
  return true;
}

/** Estado del simulacro; fuera del proveedor devuelve un estado inerte (start rechaza "Simulacro no disponible"). */
export function useScenario(): ScenarioState {
  return useContext(ScenarioContext) ?? INERT;
}

/** Proveedor del simulacro para /mando: sobrevive a la navegación interna y muestra el chip flotante. */
export function ScenarioProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [data, setData] = useState<ScenarioData>(IDLE);
  // Generación: cada start/stop la incrementa; resultados de una generación vieja se ignoran.
  const genRef = useRef(0);
  const ctrlRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);

  const stop = useCallback(() => {
    genRef.current += 1;
    ctrlRef.current?.abort();
    ctrlRef.current = null;
    runningRef.current = false;
    setData(IDLE);
  }, []);

  const dismiss = useCallback(() => {
    if (runningRef.current) return;
    setData(IDLE);
  }, []);

  const start = useCallback((): Promise<void> => {
    if (runningRef.current) return Promise.resolve();
    const gen = ++genRef.current;
    const ctrl = new AbortController();
    ctrlRef.current?.abort();
    ctrlRef.current = ctrl;
    runningRef.current = true;
    setData({ ...IDLE, running: true });

    const current = () => genRef.current === gen;
    let resolveStarted: () => void = () => {};
    const startedPromise = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });

    void runScenario(
      {
        callStep: (req, signal) => api.demo.scenario(req, { signal }),
        sleep: abortableSleep,
        onStarted: (incidentId) => {
          if (!current()) return;
          setData((d) => ({ ...d, incidentId }));
          router.push("/mando/" + incidentId);
          resolveStarted();
        },
        onProgress: (p) => {
          if (!current()) return;
          setData((d) => ({ ...d, incidentId: p.incidentId, step: p.step, total: p.total, label: p.label }));
        },
      },
      ctrl.signal,
      { shouldRetry: isRetryable },
    ).then((res) => {
      resolveStarted();
      if (!current()) return;
      runningRef.current = false;
      ctrlRef.current = null;
      if (res.ok) {
        setData((d) => ({ ...d, running: false, finished: true, error: null }));
      } else if ("error" in res) {
        setData((d) => ({ ...d, running: false, finished: false, error: errorMessage(res.error) }));
      } else {
        setData(IDLE);
      }
    });

    return startedPromise;
  }, [router]);

  // Al salir de /mando por completo, el simulacro se cancela.
  useEffect(() => {
    return () => {
      genRef.current += 1;
      ctrlRef.current?.abort();
      ctrlRef.current = null;
      runningRef.current = false;
    };
  }, []);

  // "Simulacro terminado" se oculta solo; los errores quedan hasta que alguien los cierre.
  const { finished, error } = data;
  useEffect(() => {
    if (!finished || error) return;
    const timer = setTimeout(() => setData((d) => (d.finished && !d.running ? IDLE : d)), FINISHED_HIDE_MS);
    return () => clearTimeout(timer);
  }, [finished, error]);

  const value = useMemo<ScenarioState>(() => ({ ...data, start, stop, dismiss }), [data, start, stop, dismiss]);
  // En la página del incidente del simulacro el aviso va en línea (lo dibuja la vista); flotando taparía paneles.
  const onOwnIncident = data.incidentId !== null && pathname === `/mando/${data.incidentId}`;
  const showChip = (data.running || data.finished || data.error !== null) && !onOwnIncident;

  return (
    <ScenarioContext.Provider value={value}>
      {children}
      {showChip ? <ScenarioChip scenario={value} onDismiss={dismiss} /> : null}
    </ScenarioContext.Provider>
  );
}
