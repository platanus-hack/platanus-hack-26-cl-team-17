"use client";

import { useState } from "react";
import { Drone, Lock, Plus } from "lucide-react";
import { Button, Card, useToast } from "@/components/ui";
import type { CreateMissionResponse } from "@/lib/contract";
import { LIMITS } from "@/lib/domain";
import { MAX_ACTIVE_MISSIONS } from "@/lib/drone/plan";
import { cn } from "@/lib/cn";
import { CredentialsDialog, type MissionCredentials } from "./CredentialsDialog";
import { DeployForm } from "./DeployForm";
import { MissionCard } from "./MissionCard";
import { MissionHistory } from "./MissionHistory";
import { absoluteSensorUrl, splitMissions } from "./model";
import type { DronePanelProps } from "./types";

function Intro({ aiReal }: { aiReal: boolean }) {
  return (
    <div className="flex items-start gap-3">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-md border border-drone/40 bg-drone-soft">
        <Drone aria-hidden="true" className="size-5 text-drone" />
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <h3 className="font-display text-lg leading-tight font-semibold text-text">Sin dron en este incidente</h3>
        <p className="text-sm text-muted">
          Despliega un dron para ver la escena desde arriba: techumbre, patio posterior y exposiciones. Su posición
          aparece aquí y en el mapa, y sus cuadros llegan en lotes de {LIMITS.DRONE_BATCH_FRAMES} que la IA analiza junto
          con los videos de los vecinos.
          {!aiReal && <strong className="font-semibold text-warning"> En esta instancia el análisis es SIMULADO.</strong>}
        </p>
      </div>
    </div>
  );
}

/** Panel de dron del puesto de mando: despliegue, misiones activas con telemetría y órdenes, e historial. */
export function DronePanel({ incident, missions, media, mode, onChanged, onOpenMedia, className }: DronePanelProps) {
  const { toast } = useToast();
  const [deploying, setDeploying] = useState(false);
  // El token solo vive aquí, en memoria, hasta cerrar el diálogo: nunca se guarda ni se vuelve a pedir.
  const [credentials, setCredentials] = useState<MissionCredentials | null>(null);

  const { active, finished } = splitMissions(missions);
  const closed = incident.status === "closed";
  const atLimit = active.length >= MAX_ACTIVE_MISSIONS;
  const canDeploy = !closed && !atLimit;
  const center = { lat: incident.lat, lng: incident.lng };
  const showForm = canDeploy && (deploying || missions.length === 0);

  const onCreated = (res: CreateMissionResponse) => {
    setDeploying(false);
    onChanged();
    const m = res.mission;
    toast({
      title: `Dron ${m.label} desplegado`,
      description: m.mode === "simulated" ? "Misión SIMULADA: telemetría generada, sin cámara." : "Conecta el sensor con el enlace que aparece ahora.",
      tone: "info",
    });
    if (m.mode !== "simulated") {
      const origin = window.location.origin;
      setCredentials({
        missionId: m.id,
        label: m.label,
        mode: m.mode,
        origin,
        sensorUrl: absoluteSensorUrl(origin, res.sensor_path),
        token: res.ingest_token,
        lat: incident.lat,
        lng: incident.lng,
      });
    }
  };

  return (
    <div className={cn("flex flex-col gap-3 p-3", className)}>
      {missions.length > 0 && (
        <div className="flex items-center justify-between gap-2">
          <h3 className="label-caps text-xs text-muted">
            {active.length > 0 ? `Drones activos · ${active.length} de ${MAX_ACTIVE_MISSIONS}` : "Sin drones en vuelo"}
          </h3>
          {canDeploy && !deploying && (
            <Button size="sm" icon={Plus} onClick={() => setDeploying(true)}>
              Desplegar dron
            </Button>
          )}
        </div>
      )}

      {missions.length === 0 && <Intro aiReal={mode.ai === "claude"} />}

      {closed && (
        <p className="flex items-start gap-2 rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-muted">
          <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          El incidente está cerrado: no se pueden desplegar drones.
        </p>
      )}
      {!closed && atLimit && (
        <p className="text-xs text-muted">
          Hay {MAX_ACTIVE_MISSIONS} drones activos, el máximo por incidente. Retorna o aborta uno para desplegar otro.
        </p>
      )}

      {showForm &&
        (missions.length === 0 ? (
          <DeployForm incidentId={incident.id} onCreated={onCreated} />
        ) : (
          <Card padding="md" className="flex flex-col gap-3">
            <h3 className="font-display text-lg leading-tight font-semibold text-text">Desplegar otro dron</h3>
            <DeployForm incidentId={incident.id} onCreated={onCreated} onCancel={() => setDeploying(false)} />
          </Card>
        ))}

      {active.map((m) => (
        <MissionCard key={m.id} mission={m} center={center} media={media} onChanged={onChanged} onOpenMedia={onOpenMedia} />
      ))}

      <MissionHistory missions={finished} media={media} onOpenMedia={onOpenMedia} />

      <CredentialsDialog credentials={credentials} onClose={() => setCredentials(null)} />
    </div>
  );
}
