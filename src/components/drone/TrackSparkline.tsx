import type { DroneMission } from "@/lib/domain";
import type { LatLng } from "@/lib/geo";
import { formatDistance } from "@/lib/format";
import { cn } from "@/lib/cn";
import { trackToSvg } from "./model";

export interface TrackSparklineProps {
  mission: Pick<DroneMission, "label" | "track" | "last" | "radius_m" | "pattern" | "status">;
  center: LatLng;
  distanceM: number | null;
  className?: string;
}

/** Vista cenital compacta de la traza reciente: incidente al centro, Norte arriba. */
export function TrackSparkline({ mission, center, distanceM, className }: TrackSparklineProps) {
  const track = mission.track.length > 0 ? mission.track : mission.last ? [mission.last] : [];
  const svg = trackToSvg(track, center, { radiusM: mission.radius_m, pattern: mission.pattern, size: 120 });
  const c = svg.size / 2;
  const label =
    track.length === 0
      ? `Traza del dron ${mission.label}: aún sin posiciones.`
      : `Traza del dron ${mission.label} vista desde arriba, Norte arriba, últimas ${track.length > 120 ? 120 : track.length} posiciones. ` +
        `El dron está a ${formatDistance(distanceM)} del incidente.`;
  return (
    <figure className={cn("flex flex-col items-center gap-1", className)}>
      <svg
        viewBox={`0 0 ${svg.size} ${svg.size}`}
        role="img"
        aria-label={label}
        className="size-32 rounded-md border border-line bg-surface-2"
      >
        <title>{label}</title>
        <text x={c} y={9} textAnchor="middle" className="fill-faint font-mono" fontSize={7} aria-hidden="true">
          N
        </text>
        {svg.orbitR > 0 && (
          <circle
            cx={c}
            cy={c}
            r={svg.orbitR}
            fill="none"
            className="stroke-drone/50"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
        )}
        {svg.path && (
          <path
            d={svg.path}
            fill="none"
            className="stroke-drone"
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity={0.85}
          />
        )}
        {/* Incidente */}
        <g className="stroke-critical" strokeWidth={1.5}>
          <line x1={c - 4} y1={c - 4} x2={c + 4} y2={c + 4} />
          <line x1={c - 4} y1={c + 4} x2={c + 4} y2={c - 4} />
        </g>
        {svg.current && (
          <circle cx={svg.current.x} cy={svg.current.y} r={3.5} className="fill-drone stroke-bg" strokeWidth={1.5} />
        )}
      </svg>
      <figcaption className="text-center text-[11px] leading-tight text-faint">
        <span className="text-critical" aria-hidden="true">
          ×
        </span>{" "}
        incidente · lado ≈ {formatDistance(svg.halfExtentM * 2)}
      </figcaption>
    </figure>
  );
}
