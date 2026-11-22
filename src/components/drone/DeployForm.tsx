"use client";

import { useId, useState, type FormEvent } from "react";
import { CircleAlert, Drone, FlaskConical, Smartphone, type LucideIcon } from "lucide-react";
import { Button, Field, fieldMessageIds, Input, SegmentedControl } from "@/components/ui";
import { ApiClientError, api, errorMessage } from "@/lib/client/api";
import type { CreateMissionResponse } from "@/lib/contract";
import type { MissionMode, MissionPattern } from "@/lib/domain";
import { cn } from "@/lib/cn";
import {
  ALTITUDE_MAX_M,
  ALTITUDE_MIN_M,
  DEFAULT_ALTITUDE_M,
  DEFAULT_RADIUS_M,
  RADIUS_MAX_M,
  RADIUS_MIN_M,
  validateMissionForm,
} from "./model";

const MODE_OPTIONS: { value: MissionMode; label: string; icon: LucideIcon }[] = [
  { value: "simulated", label: "Simulado", icon: FlaskConical },
  { value: "device", label: "Teléfono como sensor", icon: Smartphone },
  { value: "api", label: "Dron real por API", icon: Drone },
];

const MODE_HELP: Record<MissionMode, string> = {
  simulated:
    "Para practicar o mostrar la plataforma: la telemetría la genera Vigía y no hay cámara. Queda rotulado como SIMULADO.",
  device: "Un teléfono hace de dron: abre un enlace, comparte su GPS y brújula y transmite video en vivo (no queda guardado). Sirve también desde una escala o un punto alto.",
  api: "Un dron real (o el puente de prueba) envía telemetría y cuadros por la API con un token propio. Te mostraremos el comando para conectarlo.",
};

const PATTERN_OPTIONS: { value: MissionPattern; label: string }[] = [
  { value: "orbit", label: "Órbita" },
  { value: "hover", label: "Punto fijo" },
  { value: "grid", label: "Barrido" },
];

const PATTERN_HELP: Record<MissionPattern, string> = {
  orbit: "Gira alrededor del incidente mirando al centro: muestra todas las caras y las exposiciones.",
  hover: "Se queda sobre el incidente: vista cenital de techumbre y patio.",
  grid: "Recorre el área en franjas: útil para incendios forestales o búsqueda en un sector.",
};

/** Mensaje claro para errores al desplegar. */
function createErrorMessage(err: unknown): string {
  if (err instanceof ApiClientError) {
    if (err.code === "conflict") {
      return err.message && err.message !== "Conflicto con el estado actual."
        ? err.message
        : "Ya hay 2 drones activos en este incidente. Retorna o aborta uno antes de desplegar otro.";
    }
    if (err.code === "unauthorized") return "Tu sesión expiró. Inicia sesión de nuevo para desplegar un dron.";
    if (err.code === "forbidden") return "Tu cuenta no tiene permiso para desplegar drones.";
    if (err.code === "invalid") return `No pudimos desplegar el dron: ${err.message}`;
  }
  return `No pudimos desplegar el dron. ${errorMessage(err)}`;
}

export interface DeployFormProps {
  incidentId: string;
  /** Se llama tras crear la misión (con la respuesta completa, que trae el token una sola vez). */
  onCreated: (res: CreateMissionResponse) => void;
  onCancel?: () => void;
  submitLabel?: string;
  className?: string;
}

export function DeployForm({ incidentId, onCreated, onCancel, submitLabel = "Desplegar dron", className }: DeployFormProps) {
  const uid = useId();
  const radiusId = `${uid}-radius`;
  const altitudeId = `${uid}-altitude`;
  const [mode, setMode] = useState<MissionMode>("simulated");
  const [pattern, setPattern] = useState<MissionPattern>("orbit");
  const [radius, setRadius] = useState(String(DEFAULT_RADIUS_M));
  const [altitude, setAltitude] = useState(String(DEFAULT_ALTITUDE_M));
  const [errors, setErrors] = useState<{ radius?: string; altitude?: string }>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    setSubmitError(null);
    const v = validateMissionForm({ mode, pattern, radius, altitude });
    if (!v.ok) {
      setErrors(v.errors);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const res = await api.missions.create(incidentId, v.input);
      onCreated(res);
    } catch (err) {
      setSubmitError(createErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const radiusIds = fieldMessageIds(radiusId);
  const altitudeIds = fieldMessageIds(altitudeId);

  return (
    <form onSubmit={onSubmit} noValidate className={cn("flex flex-col gap-4", className)} aria-label="Desplegar dron">
      <div className="flex flex-col gap-1.5">
        <span className="label-caps text-xs text-muted">Origen de los datos</span>
        <SegmentedControl options={MODE_OPTIONS} value={mode} onChange={setMode} ariaLabel="Origen de los datos del dron" className="flex-wrap" />
        <p className="text-sm text-muted">{MODE_HELP[mode]}</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="label-caps text-xs text-muted">Patrón de vuelo</span>
        <SegmentedControl options={PATTERN_OPTIONS} value={pattern} onChange={setPattern} ariaLabel="Patrón de vuelo" />
        <p className="text-sm text-muted">{PATTERN_HELP[pattern]}</p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {pattern !== "hover" && (
          <Field
            label={pattern === "grid" ? "Medio lado del área (m)" : "Radio de la órbita (m)"}
            htmlFor={radiusId}
            hint={`Entre ${RADIUS_MIN_M} y ${RADIUS_MAX_M} m desde el incidente.`}
            error={errors.radius}
          >
            <Input
              id={radiusId}
              type="number"
              inputMode="decimal"
              min={RADIUS_MIN_M}
              max={RADIUS_MAX_M}
              step={5}
              value={radius}
              onChange={(e) => setRadius(e.target.value)}
              invalid={Boolean(errors.radius)}
              aria-describedby={errors.radius ? radiusIds.error : radiusIds.hint}
              aria-invalid={errors.radius ? true : undefined}
            />
          </Field>
        )}
        <Field
          label="Altura de vuelo (m)"
          htmlFor={altitudeId}
          hint={`Entre ${ALTITUDE_MIN_M} y ${ALTITUDE_MAX_M} m sobre el terreno. Mantente sobre cables y árboles.`}
          error={errors.altitude}
        >
          <Input
            id={altitudeId}
            type="number"
            inputMode="decimal"
            min={ALTITUDE_MIN_M}
            max={ALTITUDE_MAX_M}
            step={5}
            value={altitude}
            onChange={(e) => setAltitude(e.target.value)}
            invalid={Boolean(errors.altitude)}
            aria-describedby={errors.altitude ? altitudeIds.error : altitudeIds.hint}
            aria-invalid={errors.altitude ? true : undefined}
          />
        </Field>
      </div>

      {submitError && (
        <p role="alert" className="flex items-start gap-2 rounded-md border border-critical/40 bg-critical-soft px-3 py-2 text-sm text-critical">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{submitError}</span>
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" icon={Drone} loading={busy}>
          {submitLabel}
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancelar
          </Button>
        )}
      </div>
    </form>
  );
}
