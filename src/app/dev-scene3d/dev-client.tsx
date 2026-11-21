"use client";
// Cliente de la página temporal de verificación del visor (se borra al terminar).
import { useState } from "react";
import { Scene3D, type SceneSelection } from "@/components/scene3d";
import { SAMPLE_SCENE } from "@/components/scene3d/sample-scene";
import { SHOWCASE_A } from "@/lib/demo/data-showcase-a";
import { SHOWCASE_B } from "@/lib/demo/data-showcase-b";
import { destination } from "@/lib/geo";
import type { MediaView } from "@/lib/contract";
import type { DroneMission, SceneModel } from "@/lib/domain";

const THUMB =
  "data:image/svg+xml;utf8," +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#3a2a22"/><rect x="40" y="20" width="80" height="60" fill="#6b4a3a"/><circle cx="100" cy="35" r="14" fill="#ff7a3d"/></svg>');

export function DevScene({ which, compact, simulated }: { which: string; compact: boolean; simulated: boolean }) {
  const spec = which === "b" ? SHOWCASE_B : SHOWCASE_A;
  const scene: SceneModel | null = which === "null" ? null : which === "sample" ? SAMPLE_SCENE : spec.scene;
  const incident = { id: `dev-${which}`, lat: spec.lat, lng: spec.lng, type: spec.type, title: spec.title };
  const media = (scene?.cameras ?? []).map(
    (c) =>
      ({
        id: `m-${c.media_ref}`,
        label: c.media_ref,
        source: c.z > 10 ? "drone" : "citizen",
        kind: "video",
        lat: null,
        lng: null,
        heading_deg: null,
        accuracy_m: null,
        frames: [],
        urls: { video: null, poster: THUMB, frames: [] },
      }) as unknown as MediaView,
  );
  const origin = { lat: spec.lat, lng: spec.lng };
  const track = Array.from({ length: 60 }, (_, i) => {
    const p = destination(origin, i * 6, 60);
    return { at: new Date(1_700_000_000_000 + i * 1000).toISOString(), lat: p.lat, lng: p.lng, alt_m: 45, heading_deg: (i * 6 + 90) % 360, speed_ms: 8, battery_pct: 90 - i * 0.1 };
  });
  const missions = which === "a" ? ([{ id: "mis-1", label: "D1", status: "on_station", mode: "simulated", last: track[track.length - 1], track }] as unknown as DroneMission[]) : [];
  const [selection, setSelection] = useState<SceneSelection | null>(null);
  const [updatedAt] = useState(() => new Date(Date.now() - 95_000).toISOString());
  const [opened, setOpened] = useState<string>("");
  return (
    <div className="flex h-dvh flex-col gap-2 p-2">
      <p className="text-xs text-muted" data-testid="opened">
        Página temporal de verificación · seleccionado: {selection ? `${selection.kind}:${selection.id}` : "—"} · abierto: {opened || "—"}
      </p>
      <Scene3D
        scene={scene}
        incident={incident}
        media={media}
        missions={missions}
        engine={simulated ? "simulated" : "claude"}
        updatedAt={updatedAt}
        updating={false}
        selection={selection}
        onSelect={setSelection}
        onOpenMedia={(l, f) => setOpened(`${l}${f !== undefined ? `#${f}` : ""}`)}
        compact={compact}
        className="min-h-0 flex-1"
      />
    </div>
  );
}
