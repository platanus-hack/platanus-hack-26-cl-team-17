"use client";

import { ChevronRight, MapPin } from "lucide-react";
import { Card, TimeAgo } from "@/components/ui";
import type { PublicIncident } from "@/lib/contract";
import { formatDistance } from "@/lib/format";
import { incidentTypeIcon } from "@/lib/labels";
import { reportTypeLabel } from "./TypePicker";

/** Lista de emergencias activas cercanas; cada una lleva a /reportar/<código>. */
export function NearbyIncidents({ incidents, labelledBy }: { incidents: PublicIncident[]; labelledBy: string }) {
  return (
    <ul aria-labelledby={labelledBy} className="flex flex-col gap-2.5">
      {incidents.map((incident) => {
        const Icon = incidentTypeIcon[incident.type];
        const typeText = reportTypeLabel(incident.type);
        const address = incident.address.trim();
        return (
          <li key={incident.code}>
            <Card
              href={`/reportar/${incident.code}`}
              padding="none"
              className="border-line-strong"
            >
              <div className="flex min-h-16 items-center gap-3.5 px-4 py-3.5">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-md bg-critical-soft text-critical">
                  <Icon aria-hidden className="size-6" strokeWidth={2.25} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-lg leading-tight font-semibold text-text">{typeText}</p>
                  <p className="mt-1 flex items-start gap-1.5 text-base leading-snug text-text">
                    <MapPin aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
                    <span className="min-w-0 break-words">{address || "Dirección por confirmar"}</span>
                  </p>
                  <p className="mt-1 text-sm text-muted">
                    {incident.distance_m !== null && (
                      <>
                        <span className="tabular">A {formatDistance(incident.distance_m)} de ti</span>
                        <span aria-hidden> · </span>
                      </>
                    )}
                    Avisada <TimeAgo iso={incident.created_at} />
                  </p>
                </div>
                <ChevronRight aria-hidden className="size-6 shrink-0 text-muted" />
              </div>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}
