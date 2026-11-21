"use client";

import { useEffect, useRef } from "react";
import { api } from "@/lib/client/api";
import type { DroneMission } from "@/lib/domain";
import { isMissionActive } from "@/lib/drone/plan";

/** Intervalo entre rondas de avance del simulador. */
export const SIMULATED_TICK_MS = 2000;

const isSimulatedActive = (m: Pick<DroneMission, "mode" | "status">) => m.mode === "simulated" && isMissionActive(m);

/**
 * Hace avanzar las misiones SIMULADAS activas (POST /api/missions/[id]/tick cada ~2 s).
 * Las rondas nunca se solapan (se espera la anterior), se pausan con la pestaña oculta y
 * los errores transitorios se ignoran: se reintenta en la ronda siguiente.
 */
export function useSimulatedMissionTicker(missions: DroneMission[], onChanged: () => void): void {
  const missionsRef = useRef(missions);
  const onChangedRef = useRef(onChanged);
  useEffect(() => {
    missionsRef.current = missions;
    onChangedRef.current = onChanged;
  });

  const enabled = missions.some(isSimulatedActive);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const { signal } = controller;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let running = false;

    const schedule = (ms: number) => {
      if (signal.aborted) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(round, ms);
    };

    async function round() {
      timer = null;
      if (signal.aborted || running) return;
      // Pestaña oculta: no se agenda nada; visibilitychange retoma.
      if (document.hidden) return;
      const ids = missionsRef.current.filter(isSimulatedActive).map((m) => m.id);
      if (ids.length === 0) return;
      running = true;
      let advanced = false;
      await Promise.all(
        ids.map(async (id) => {
          try {
            await api.missions.tick(id, { signal });
            advanced = true;
          } catch {
            // Red caída, servidor reiniciando o misión recién cerrada: se reintenta en la ronda siguiente.
          }
        }),
      );
      running = false;
      if (signal.aborted) return;
      if (advanced) onChangedRef.current();
      schedule(SIMULATED_TICK_MS);
    }

    const onVisibility = () => {
      if (!document.hidden && !running && timer === null) schedule(0);
    };

    document.addEventListener("visibilitychange", onVisibility);
    schedule(0);
    return () => {
      controller.abort();
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled]);
}
