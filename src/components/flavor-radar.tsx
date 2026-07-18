import { FLAVOR_WHEEL } from "@/lib/flavor-wheel";

export interface FlavorRadarProps {
  /** Wedge id -> 0-10 intensity (bottles.flavorProfile). */
  profile: Record<string, number> | null | undefined;
  /** Rendered width/height in px (SVG scales responsively via viewBox). */
  size?: number;
}

const MAX_SCORE = 10;

/**
 * Short display labels for the radar only — long wedge names would clip at
 * the SVG edge on a 390px viewport. Taxonomy labels stay canonical in
 * FLAVOR_WHEEL.
 */
export const RADAR_LABELS: Record<string, string> = {
  peaty: "Peaty",
};

export function radarLabel(wedgeId: string, fallback: string): string {
  return RADAR_LABELS[wedgeId] ?? fallback;
}

/**
 * Pure-SVG radar (octagon) of the 8 flavor-wheel wedge scores. No chart
 * library; safe to render from server components.
 */
export function FlavorRadar({ profile, size = 300 }: FlavorRadarProps) {
  const wedges = FLAVOR_WHEEL;
  const n = wedges.length;
  const cx = size / 2;
  const cy = size / 2;
  // Generous margin so every label fits fully inside the viewBox (DESIGN.md
  // rule 7: text never touches an edge — SVG labels included).
  const radius = size / 2 - 52;
  const labelRadius = radius + 24;

  const angleAt = (i: number) => (2 * Math.PI * i) / n - Math.PI / 2;
  const pointAt = (i: number, r: number): [number, number] => [
    cx + Math.cos(angleAt(i)) * r,
    cy + Math.sin(angleAt(i)) * r,
  ];
  const ringPoints = (r: number) =>
    wedges.map((_, i) => pointAt(i, r).map((v) => v.toFixed(1)).join(",")).join(" ");

  if (!profile || Object.keys(profile).length === 0) {
    return (
      <div className="card-flat flex items-center justify-center p-6 text-sm text-muted">
        No flavor profile yet for this bottle.
      </div>
    );
  }

  const dataPoints = wedges
    .map((w, i) => {
      const score = Math.max(0, Math.min(MAX_SCORE, profile[w.id] ?? 0));
      return pointAt(i, (score / MAX_SCORE) * radius)
        .map((v) => v.toFixed(1))
        .join(",");
    })
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      width="100%"
      style={{ maxWidth: size }}
      role="img"
      aria-label="Flavor profile radar chart"
      data-testid="flavor-radar"
    >
      {/* warm hairline grid rings */}
      {[0.25, 0.5, 0.75, 1].map((f, idx) => (
        <polygon
          key={f}
          points={ringPoints(radius * f)}
          fill="none"
          stroke="var(--border, #392e20)"
          strokeWidth={1}
          opacity={idx === 3 ? 0.9 : 0.45}
        />
      ))}
      {/* axes */}
      {wedges.map((w, i) => {
        const [x, y] = pointAt(i, radius);
        return (
          <line
            key={w.id}
            x1={cx}
            y1={cy}
            x2={x}
            y2={y}
            stroke="var(--border, #392e20)"
            strokeWidth={1}
            opacity={0.4}
          />
        );
      })}
      {/* data polygon */}
      <polygon
        data-testid="flavor-radar-polygon"
        points={dataPoints}
        fill="var(--accent, #e8a13c)"
        fillOpacity={0.35}
        stroke="var(--accent, #e8a13c)"
        strokeWidth={2}
        strokeLinejoin="round"
      />
      {/* subtle vertex dots */}
      {dataPoints.split(" ").map((pt, i) => {
        const [x, y] = pt.split(",").map(Number);
        return (
          <circle
            key={wedges[i].id}
            cx={x}
            cy={y}
            r={2.5}
            fill="var(--accent, #e8a13c)"
            stroke="var(--background, #14100b)"
            strokeWidth={1}
          />
        );
      })}
      {/* small-caps labels, kept inside the viewBox */}
      {wedges.map((w, i) => {
        const [x, y] = pointAt(i, labelRadius);
        const sin = Math.sin(angleAt(i));
        const baseline = sin < -0.3 ? "auto" : sin > 0.3 ? "hanging" : "middle";
        return (
          <text
            key={w.id}
            x={x.toFixed(1)}
            y={y.toFixed(1)}
            textAnchor="middle"
            dominantBaseline={baseline}
            fontSize={10.5}
            letterSpacing="0.1em"
            style={{ textTransform: "uppercase" }}
            fill="var(--muted, #a3927a)"
          >
            {radarLabel(w.id, w.label)}
          </text>
        );
      })}
    </svg>
  );
}
