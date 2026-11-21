"use client";

import { useState } from "react";
import {
  Ban,
  BatteryMedium,
  Compass,
  FlaskConical,
  Gauge,
  Images,
  MapPin,
  Mountain,
  Play,
  Smartphone,
  TriangleAlert,
  Undo2,
  Drone as DroneIcon,
  type LucideIcon,
} from "lucide-react";
import { Badge, Button, Card, ConfirmDialog, Elapsed, ProgressBar, Stat, StatusDot, useNow, useToast } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import type { MediaView } from "@/lib/contract";
import type { DroneMission, MissionMode } from "@/lib/domain";
import type { LatLng } from "@/lib/geo";
import { formatDistance, formatHeading, formatNumber, pluralize } from "@/lib/format";
import { missionActionLabel, missionStatusIcon, missionStatusLabel, missionStatusTone } from "@/lib/labels";
import { toneText } from "@/components/ui/tone";
import { cn } from "@/lib/cn";
import { BatchList } from "./BatchList";
import { LiveFeed } from "./LiveFeed";
import { TrackSparkline } from "./TrackSparkline";
import {
  BATTERY_CRITICAL_PCT,
  batteryRatio,
  batteryTone,
  distanceToIncidentM,
  droneBatchesFor,
  pendingCommandText,
  signalState,
} from "./model";

type Action = "recall" | "abort" | "resume";

const MODE_BADGE: Record<MissionMode, { text: string; icon: LucideIcon; tone: "warning" | "drone" | "info" }> = {
  simulated: { text: "Simulado", icon: FlaskConical, tone: "warning" },
  device: { text: "Teléfono sensor", icon: Smartphone, tone: "drone" },
  api: { text: "Dron real · API", icon: DroneIcon, tone: "info" },
};

const PATTERN_SHORT: Record<DroneMission["pattern"], string> = {
  orbit: "Órbita",
  hover: "Punto fijo",
  grid: "Barrido",
};

function planText(m: Pick<DroneMission, "pattern" | "radius_m" | "altitude_m">): string {
  const alt = `${Math.round(m.altitude_m)} m de altura`;
  return m.pattern === "hover" ? `${PATTERN_SHORT.hover} · ${alt}` : `${PATTERN_SHORT[m.pattern]} de ${Math.round(m.radius_m)} m · ${alt}`;
}

const CONFIRM: Record<Action, { title: (l: string) => string; description: (m: DroneMission) => string; label: string; danger: boolean }> = {
  recall: {
    title: (l) => `¿Ordenar el regreso del dron ${l}?`,
    description: (m) =>
      m.mode === "simulated"
        ? "El dron simulado deja la zona y vuelve al punto de despegue. Puedes reanudar la misión mientras no aterrice."
        : "El dron recibirá la orden en su próximo envío de telemetría y debe volver al punto de despegue. Puedes reanudar la misión mientras no aterrice.",
    label: "Ordenar regreso",
    danger: false,
  },
  abort: {
    title: (l) => `¿Abortar la misión del dron ${l}?`,
    description: (m) =>
      m.mode === "simulated"
        ? "El vuelo simulado se detiene de inmediato y la misión queda cerrada. Una misión abortada no se puede reanudar."
        : "El piloto debe aterrizar de inmediato en un lugar seguro. Una misión abortada no se puede reanudar.",
    label: "Abortar misión",
    danger: true,
  },
  resume: {
    title: (l) => `¿Reanudar la misión del dron ${l}?`,
    description: () => "Se retira la orden de regreso y el dron vuelve a su patrón de vuelo sobre el incidente.",
    label: "Reanudar",
    danger: false,
  },
};

const SENT_TOAST: Record<Action, (l: string) => string> = {
  recall: (l) => `Orden enviada: el dron ${l} regresa a la base`,
  abort: (l) => `Orden enviada: abortar la misión de ${l}`,
  resume: (l) => `Orden enviada: el dron ${l} reanuda la misión`,
};

export interface MissionCardProps {
  mission: DroneMission;
  center: LatLng;
  media: MediaView[];
  onChanged: () => void;
  onOpenMedia?: (mediaLabel: string) => void;
  className?: string;
}

/** Misión activa: estado grande, telemetría en vivo, traza, lotes de cuadros y órdenes del mando. */
export function MissionCard({ mission: m, center, media, onChanged, onOpenMedia, className }: MissionCardProps) {
  const now = useNow(1000);
  const { toast } = useToast();
  const [confirm, setConfirm] = useState<Action | null>(null);

  const signal = signalState(m, now);
  const last = m.last;
  const distance = distanceToIncidentM(last, center);
  const battery = last?.battery_pct ?? null;
  const bTone = batteryTone(battery);
  const ratio = batteryRatio(battery);
  const StatusIcon = missionStatusIcon[m.status];
  const sTone = missionStatusTone[m.status];
  const pending = pendingCommandText(m.command);
  const batches = droneBatchesFor(media, m.id);
  const badge = MODE_BADGE[m.mode];
  const simulated = m.mode === "simulated";

  const run = async (action: Action) => {
    try {
      await api.missions.command(m.id, action);
      toast({ title: SENT_TOAST[action](m.label), tone: action === "abort" ? "warning" : "info" });
      onChanged();
    } catch (err) {
      toast({ title: `No pudimos enviar la orden al dron ${m.label}`, description: errorMessage(err), tone: "critical" });
      onChanged();
    } finally {
      setConfirm(null);
    }
  };

  return (
    <Card tone={sTone === "neutral" ? "drone" : sTone} padding="none" className={cn("flex flex-col", className)}>
      {/* Encabezado: identidad y estado grande */}
      <div className="flex flex-col gap-2 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-display text-2xl leading-none font-bold text-drone">{m.label}</span>
          <Badge tone={badge.tone} icon={badge.icon} size="sm" variant={simulated ? "solid" : "soft"}>
            {badge.text}
          </Badge>
          <span className="text-xs text-muted">{planText(m)}</span>
        </div>
        <div className="flex items-end justify-between gap-3">
          <p className={cn("flex items-center gap-2 font-display text-3xl leading-none font-semibold", toneText[sTone === "neutral" ? "drone" : sTone])}>
            <StatusIcon aria-hidden="true" className="size-7 shrink-0" />
            {missionStatusLabel[m.status]}
          </p>
          {m.started_at && (
            <span className="text-right text-xs text-muted">
              <span className="label-caps block text-[10px] text-faint">En vuelo</span>
              <Elapsed since={m.started_at} className="font-mono text-sm text-text" title="Tiempo desde el despegue" />
            </span>
          )}
        </div>
        <p role="status" className={cn("flex items-center gap-2 text-sm", toneText[signal.tone])}>
          <StatusDot tone={signal.tone} pulse={signal.level === "live"} size="sm" />
          <span className={cn(signal.tone === "neutral" && "text-muted")}>{signal.text}</span>
        </p>
      </div>

      {simulated && (
        <p role="note" className="mx-3 mb-2 flex items-start gap-2 rounded-md border border-warning/40 bg-warning-soft px-2.5 py-1.5 text-xs text-warning">
          <FlaskConical aria-hidden="true" className="mt-px size-3.5 shrink-0" />
          <span>
            <strong className="label-caps">Simulado</strong> — telemetría generada, sin cámara. No representa un dron real.
          </span>
        </p>
      )}

      {pending && (
        <div
          role="alert"
          className={cn(
            "mx-3 mb-2 flex items-start gap-2 rounded-md border px-2.5 py-2 text-sm",
            m.command === "abort" ? "border-critical/40 bg-critical-soft text-critical" : "border-info/40 bg-info-soft text-info",
          )}
        >
          {m.command === "abort" ? (
            <Ban aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          ) : (
            <Undo2 aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          )}
          <p className="leading-snug">
            <span className="font-display text-base font-semibold">Orden: {pending}.</span>{" "}
            <span className="text-text/80">
              {simulated
                ? "El simulador la aplica en el próximo ciclo."
                : "El dron la recibe en su próximo envío de telemetría; la misión sigue abierta hasta que confirme."}
            </span>
          </p>
        </div>
      )}

      {/* Video en vivo (los drones simulados no tienen cámara) */}
      {!simulated && (
        <div className="border-t border-line p-3">
          <LiveFeed missionId={m.id} label={m.label} active />
        </div>
      )}

      {/* Telemetría */}
      <div className="flex gap-3 border-t border-line p-3">
        <TrackSparkline mission={m} center={center} distanceM={distance} className="shrink-0" />
        <div className="grid min-w-0 flex-1 grid-cols-2 content-start gap-x-3 gap-y-3">
          <Stat size="sm" label="Altura" icon={Mountain} value={last ? `${Math.round(last.alt_m)} m` : "—"} />
          <Stat size="sm" label="Rumbo" icon={Compass} value={last ? formatHeading(last.heading_deg) : "—"} />
          <Stat
            size="sm"
            label="Velocidad"
            icon={Gauge}
            value={last?.speed_ms != null ? `${formatNumber(last.speed_ms, 1)} m/s` : "—"}
          />
          <Stat size="sm" label="Distancia" icon={MapPin} value={formatDistance(distance)} title="Distancia del dron al incidente" />
        </div>
      </div>
      <div className="flex flex-col gap-1.5 px-3 pb-3">
        <div className="flex items-center justify-between gap-2">
          <span className={cn("flex items-center gap-1.5 text-muted", bTone !== "neutral" && toneText[bTone])}>
            <BatteryMedium aria-hidden="true" className="size-3.5" />
            <span className="label-caps text-xs">Batería</span>
          </span>
          <span className={cn("font-display text-lg leading-none font-semibold tabular", bTone === "neutral" ? "text-muted" : toneText[bTone])}>
            {battery == null ? "Sin dato" : `${Math.round(battery)} %`}
          </span>
        </div>
        <ProgressBar value={ratio ?? 0} tone={bTone === "neutral" ? "drone" : bTone} size="sm" label={`Batería del dron ${m.label}`} />
        {battery != null && battery < BATTERY_CRITICAL_PCT && (
          <p className="flex items-center gap-1.5 text-xs text-critical">
            <TriangleAlert aria-hidden="true" className="size-3.5" />
            Batería crítica: {simulated ? "el dron simulado retorna solo." : "ordena el regreso si el piloto no lo ha hecho."}
          </p>
        )}
      </div>

      {/* Cuadros */}
      <div className="flex flex-col gap-2 border-t border-line p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="label-caps flex items-center gap-1.5 text-xs text-muted">
            <Images aria-hidden="true" className="size-3.5" />
            Cuadros del dron
          </span>
          <span className="text-xs text-muted tabular">
            {pluralize(m.frames_received, "recibido", "recibidos")} · {pluralize(batches.length, "lote")}
          </span>
        </div>
        {batches.length > 0 ? (
          <BatchList batches={batches} onOpenMedia={onOpenMedia} />
        ) : (
          <p className="text-sm text-muted">
            {simulated
              ? "La misión simulada no tiene cámara: no envía cuadros."
              : m.last
                ? "Aún no llegan cuadros. El sensor envía uno cada 5 s y la IA los analiza en lotes."
                : "Esperando que el dron o el teléfono se conecte. Si perdiste el enlace, aborta esta misión y despliega otro dron."}
          </p>
        )}
      </div>

      {/* Órdenes */}
      <div className="flex flex-wrap gap-2 border-t border-line p-3">
        {m.command === "recall" ? (
          <Button size="sm" variant="primary" icon={Play} onClick={() => setConfirm("resume")}>
            {missionActionLabel.resume}
          </Button>
        ) : m.command === "continue" ? (
          <Button size="sm" icon={Undo2} onClick={() => setConfirm("recall")}>
            Retornar
          </Button>
        ) : null}
        {m.command !== "abort" && (
          <Button size="sm" variant="danger" icon={Ban} onClick={() => setConfirm("abort")}>
            Abortar
          </Button>
        )}
        {m.command === "abort" && <p className="text-sm text-muted">Esperando que el dron confirme el aborto.</p>}
      </div>

      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        onConfirm={() => (confirm ? run(confirm) : undefined)}
        title={confirm ? CONFIRM[confirm].title(m.label) : ""}
        description={confirm ? CONFIRM[confirm].description(m) : undefined}
        confirmLabel={confirm ? CONFIRM[confirm].label : undefined}
        danger={confirm ? CONFIRM[confirm].danger : false}
      />
    </Card>
  );
}
