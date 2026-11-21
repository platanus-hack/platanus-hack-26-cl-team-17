"use client";

import { useEffect, useRef } from "react";
import { Siren } from "lucide-react";
import { useToast } from "@/components/ui";
import type { IncidentSnapshot } from "@/lib/contract";
import type { TimelineEvent, TrappedStatus } from "@/lib/domain";
import { isTrappedAlarm, trappedRank, trappedStatusHeadline } from "@/lib/labels";

/** Opciones de `useIncidentAlerts`. */
export interface IncidentAlertsOptions {
  /** Acción "Ver" del aviso de un evento crítico; sin ella el aviso no trae acción. */
  onView?: (event: TimelineEvent) => void;
  /** Acción "Ver" del aviso de personas atrapadas. */
  onViewTrapped?: () => void;
}

const STORAGE_PREFIX = "vigia:seen-alerts:";
/** Tope de ids guardados por incidente (los eventos vienen acotados a 200 por snapshot). */
const MAX_STORED = 400;
/** Sobre este número de alertas en un mismo sondeo se agrupan en un solo aviso. */
const GROUP_OVER = 3;
/**
 * Los avisos críticos se cierran solos: fijos taparían las acciones de la cabecera y las pestañas de
 * actividad. Nada se pierde: la franja crítica, la línea de tiempo y la pestaña con punto rojo lo mantienen.
 */
const ALERT_TOAST_MS = 20_000;
const TRAPPED_TOAST_MS = 30_000;

/** Lee los ids vistos de sessionStorage; null si no hay nada o el navegador lo bloquea. */
function readSeen(incidentId: string): Set<string> | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_PREFIX + incidentId);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    return null;
  }
}

/** Guarda los ids vistos (los más recientes) sin romper si el almacenamiento falla. */
function writeSeen(incidentId: string, seen: Set<string>): void {
  try {
    const list = [...seen].slice(-MAX_STORED);
    window.sessionStorage.setItem(STORAGE_PREFIX + incidentId, JSON.stringify(list));
  } catch {
    /* sin almacenamiento: los avisos solo se deduplican mientras dure la vista */
  }
}

/** Clave de una escalada de atrapados: estado + momento del informe que la produjo. */
function trappedKey(status: TrappedStatus, at: string | null): string {
  return `trapped:${status}@${at ?? ""}`;
}

interface AlertMemory {
  incidentId: string;
  seen: Set<string>;
  trapped: TrappedStatus | null;
}

/**
 * Avisos (toasts) de alertas nuevas del incidente: eventos de severidad "critical" y escaladas del
 * estado de personas atrapadas. Lo existente al montar se marca como visto sin avisar.
 */
export function useIncidentAlerts(snapshot: IncidentSnapshot | null, options: IncidentAlertsOptions = {}): void {
  const { toast } = useToast();
  const memory = useRef<AlertMemory | null>(null);
  const optionsRef = useRef(options);

  useEffect(() => {
    optionsRef.current = options;
  });

  useEffect(() => {
    if (!snapshot) return;
    const incident = snapshot.incident;
    const trapped = incident.situation?.trapped.status ?? null;
    const criticalEvents = snapshot.events.filter((e) => e.severity === "critical");

    const mem = memory.current;
    if (!mem || mem.incidentId !== incident.id) {
      // Primera carga: todo lo que ya existe queda visto, sin avisar.
      const seen = readSeen(incident.id) ?? new Set<string>();
      for (const e of criticalEvents) seen.add(e.id);
      if (trapped) seen.add(trappedKey(trapped, incident.situation_updated_at));
      memory.current = { incidentId: incident.id, seen, trapped };
      writeSeen(incident.id, seen);
      return;
    }

    let changed = false;
    // Más antiguos primero, para que el aviso más reciente quede arriba.
    const fresh = criticalEvents.filter((e) => !mem.seen.has(e.id)).reverse();
    for (const e of fresh) mem.seen.add(e.id);
    if (fresh.length > 0) changed = true;

    const onView = optionsRef.current.onView;
    if (fresh.length > GROUP_OVER) {
      const latest = fresh[fresh.length - 1];
      toast({
        id: `alerts:${incident.id}:group`,
        title: `${fresh.length} alertas críticas nuevas`,
        description: latest.title,
        tone: "critical",
        duration: ALERT_TOAST_MS,
        action: onView ? { label: "Ver", onClick: () => onView(latest) } : undefined,
      });
    } else {
      for (const e of fresh) {
        toast({
          id: `alert:${e.id}`,
          title: e.title,
          description: e.detail || undefined,
          tone: "critical",
          duration: ALERT_TOAST_MS,
          action: onView ? { label: "Ver", onClick: () => onView(e) } : undefined,
        });
      }
    }

    if (trapped !== mem.trapped) {
      const key = trapped ? trappedKey(trapped, incident.situation_updated_at) : null;
      const escalated = trapped !== null && trappedRank(trapped) > trappedRank(mem.trapped);
      if (escalated && key && !mem.seen.has(key) && (isTrappedAlarm(trapped) || trapped === "possible")) {
        const onViewTrapped = optionsRef.current.onViewTrapped;
        toast({
          id: `trapped:${incident.id}`,
          title: trappedStatusHeadline[trapped],
          description: incident.situation?.trapped.basis || undefined,
          tone: isTrappedAlarm(trapped) ? "critical" : "warning",
          icon: Siren,
          duration: TRAPPED_TOAST_MS,
          action: onViewTrapped ? { label: "Ver", onClick: onViewTrapped } : undefined,
        });
      }
      if (key) mem.seen.add(key);
      mem.trapped = trapped;
      changed = true;
    }

    if (changed) writeSeen(incident.id, mem.seen);
  }, [snapshot, toast]);
}
