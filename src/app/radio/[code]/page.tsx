import { notFound } from "next/navigation";
import { CircleAlert } from "lucide-react";
import { RadioDemo } from "@/components/comms/RadioDemo";
import { config } from "@/lib/config";
import type { Incident } from "@/lib/domain";
import { HttpError } from "@/lib/http";
import { findOpenIncidentByCode, toPublicIncident } from "@/lib/server/reports";
import { getFiles, getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

interface RadioPageProps {
  params: Promise<{ code: string }>;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** /radio/VG-7K3Q — radio de demostración sin sesión (solo con VIGIA_DEMO_RADIO). */
export default async function RadioPage({ params }: RadioPageProps) {
  if (!config.demoRadio) notFound();
  const { code } = await params;
  let incident: Incident;
  try {
    incident = await findOpenIncidentByCode(safeDecode(code), { store: getStore(), files: getFiles() });
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    return (
      <div className="flex items-start gap-2 rounded-lg border border-critical/40 bg-critical-soft p-4 text-sm text-text" role="alert">
        <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-critical" />
        <p>{err.message}</p>
      </div>
    );
  }
  return <RadioDemo incident={toPublicIncident(incident)} />;
}
