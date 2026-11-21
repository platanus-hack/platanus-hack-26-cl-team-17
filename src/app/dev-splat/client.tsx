"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorMessage } from "@/lib/client/api";
import { useIncidentSnapshot } from "@/lib/client/use-live";
import { Button, Spinner } from "@/components/ui";
import { ReconstructionPanel } from "@/components/splat";

export function DevSplatClient({ incidentId }: { incidentId: string | null }) {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const { snapshot, error, refresh } = useIncidentSnapshot(incidentId);

  if (!incidentId) {
    return (
      <main className="mx-auto max-w-3xl p-4">
        <Button
          variant="primary"
          onClick={async () => {
            try {
              const { incident_id } = await api.demo.seed();
              router.replace(`/dev-splat?id=${incident_id}`);
            } catch (e) {
              setErr(errorMessage(e));
            }
          }}
        >
          Sembrar incidente demo
        </Button>
        {err && <p className="text-critical">{err}</p>}
      </main>
    );
  }
  return (
    <main className="mx-auto min-h-dvh max-w-4xl space-y-3 overflow-y-auto p-4">
      <h1 className="font-display text-xl font-semibold text-text">{snapshot?.incident.title ?? "Cargando…"}</h1>
      {error && <p className="text-critical">{errorMessage(error)}</p>}
      {!snapshot ? (
        <Spinner />
      ) : (
        <ReconstructionPanel
          incident={snapshot.incident}
          media={snapshot.media}
          mode={snapshot.mode}
          onChanged={() => void refresh()}
        />
      )}
    </main>
  );
}
