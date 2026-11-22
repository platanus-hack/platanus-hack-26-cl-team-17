/**
 * /dron/[missionId]?t=<token> — modo sensor: un teléfono hace de dron para el puesto de mando.
 * Público (sin sesión): el token de ingesta del enlace es la credencial. Se verifica aquí antes de
 * encender sensores, así un enlace incompleto o vencido muestra un mensaje claro.
 */
import type { Metadata } from "next";
import { SensorGate } from "@/components/drone/sensor/SensorGate";
import { SensorView } from "@/components/drone/sensor/SensorView";
import { isMissionActive } from "@/lib/drone/plan";
import { sha256Hex } from "@/lib/ids";
import { getStore } from "@/lib/store";

export const metadata: Metadata = {
  title: "Modo sensor del dron",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function DroneSensorPage({
  params,
  searchParams,
}: {
  params: Promise<{ missionId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { missionId } = await params;
  const query = await searchParams;
  const raw = query.t;
  const token = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";
  if (!token) return <SensorGate kind="no_token" />;

  const store = getStore();
  const mission = await store.getMission(missionId);
  const valid = mission !== null && (await store.verifyIngestToken(missionId, sha256Hex(token)));
  if (!mission || !valid) return <SensorGate kind="invalid" />;

  const incident = await store.getIncident(mission.incident_id);
  const where = incident ? ` — ${incident.title}` : "";
  if (!isMissionActive(mission)) {
    return (
      <SensorGate
        kind="ended"
        detail={`Dron ${mission.label}${where}: ${mission.status === "aborted" ? "misión abortada" : "dron en tierra"}.`}
      />
    );
  }

  return (
    <SensorView
      token={token}
      mission={{
        id: mission.id,
        label: mission.label,
        mode: mission.mode,
        pattern: mission.pattern,
        radius_m: mission.radius_m,
        altitude_m: mission.altitude_m,
        status: mission.status,
        command: mission.command,
      }}
      incident={
        incident
          ? { title: incident.title, address: incident.address, code: incident.code, lat: incident.lat, lng: incident.lng }
          : null
      }
    />
  );
}
