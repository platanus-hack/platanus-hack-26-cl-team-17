"use client";

import { Box, ExternalLink, MapPinned } from "lucide-react";
import type { BriefingSnapshot } from "@/lib/contract";
import { MiniMap } from "@/components/map";
import { Scene3D } from "@/components/scene3d";
import { formatCoord } from "@/lib/format";
import { googleMapsUrl, wazeUrl } from "./briefing-diff";
import { BriefSection } from "./parts";

/** Plano de la escena reconstruida por la IA (vista compacta del visor). */
export function SceneSection({ briefing }: { briefing: BriefingSnapshot }) {
  const { incident, scene } = briefing;
  // El contrato aún no trae scene_updated_at en el briefing: se usa solo si el servidor lo envía.
  const sceneUpdatedAt = (incident as { scene_updated_at?: string | null }).scene_updated_at ?? null;
  return (
    <BriefSection id="escena" title="Plano de la escena" icon={Box}>
      <Scene3D
        compact
        scene={scene}
        incident={{ id: incident.id, lat: incident.lat, lng: incident.lng, type: incident.type, title: incident.title }}
        media={[]}
        missions={[]}
        updatedAt={sceneUpdatedAt}
        className="h-[340px] w-full overflow-hidden rounded-md lg:h-[400px]"
      />
      <p className="mt-2 text-base leading-snug text-muted">
        Reconstrucción esquemática inferida por la IA, no a escala exacta. Confirma al llegar.
      </p>
    </BriefSection>
  );
}

/** Mapa del lugar y botones para navegar con Google Maps o Waze. */
export function MapSection({ incident }: { incident: BriefingSnapshot["incident"] }) {
  const center = { lat: incident.lat, lng: incident.lng };
  return (
    <BriefSection id="mapa" title="Ubicación" icon={MapPinned}>
      <MiniMap
        center={center}
        zoom={16}
        theme="dark"
        interactive
        markers={[{ lat: incident.lat, lng: incident.lng, label: incident.address || incident.title, tone: "critical" }]}
        className="h-64 w-full overflow-hidden rounded-md lg:h-72"
      />
      <p className="mt-2 font-mono text-sm text-muted">{formatCoord(incident.lat, incident.lng)}</p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <a
          href={googleMapsUrl(incident.lat, incident.lng)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-14 items-center justify-center gap-2 rounded-md border border-line-strong bg-surface-2 px-3 text-center text-lg leading-tight font-bold text-text hover:border-text"
        >
          Abrir en Google Maps
          <ExternalLink aria-hidden className="size-5 shrink-0" />
        </a>
        <a
          href={wazeUrl(incident.lat, incident.lng)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-14 items-center justify-center gap-2 rounded-md border border-line-strong bg-surface-2 px-3 text-center text-lg leading-tight font-bold text-text hover:border-text"
        >
          Abrir en Waze
          <ExternalLink aria-hidden className="size-5 shrink-0" />
        </a>
      </div>
    </BriefSection>
  );
}
