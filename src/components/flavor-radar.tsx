import { FLAVOR_WHEEL } from "@/lib/flavor-wheel";

export interface FlavorRadarProps {
  /** Wedge id -> 0-10 intensity (bottles.flavorProfile). */
  profile: Record<string, number> | null | undefined;
  /** Rendered width/height in px (SVG scales responsively via viewBox). */
  size?: number;
}

const MAX_SCORE = 10;

/**
 * Pure-SVG radar (octagon) of the 8 flavor-wheel wedge scores. No chart
 * library; safe to render from server components.
 */
export function FlavorRadar({ profile, size = 280 }: FlavorRadarProps) {
  const wedges = FLAVOR_WHEEL;
  const n = wedges.length;
  const cx = size / 2;
  const cy = size / 2;
  const radius = size / 2 - 46; // leave room for labels

  const angleAt = (i: number) => (2 * Math.PI * i) / n - Math.PI / 2;
  const pointAt = (i: number, r: number): [number, number] => [
    cx + Math.cos(angleAt(i)) * r,
    cy + Math.sin(angleAt(i)) * r,
  ];
  const ringPoints = (r: number) =>
    wedges.map((_, i) => pointAt(i, r).map((v) => v.toFixed(1)).join(",")).join(" ");

  if (!profile || Object.keys(profile).length === 0) {
    return (
      <div className="flex items-center justify-center rounded-xl border border-border-subtle bg-surface p-6 text-sm text-muted">
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
      {/* grid rings */}
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <polygon
          key={f}
          points={ringPoints(radius * f)}
          fill="none"
          stroke="var(--border, #3a2f22)"
          strokeWidth={1}
          opacity={0.7}
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
            stroke="var(--border, #3a2f22)"
            strokeWidth={1}
            opacity={0.5}
          />
        );
      })}
      {/* data polygon */}
      <polygon
        data-testid="flavor-radar-polygon"
        points={dataPoints}
        fill="var(--accent, #e8a13c)"
        fillOpacity={0.25}
        stroke="var(--accent, #e8a13c)"
        strokeWidth={2}
        strokeLinejoin="round"
      />
      {/* vertex dots */}
      {dataPoints.split(" ").map((pt, i) => {
        const [x, y] = pt.split(",").map(Number);
        return <circle key={wedges[i].id} cx={x} cy={y} r={3} fill={wedges[i].color} />;
      })}
      {/* labels */}
      {wedges.map((w, i) => {
        const [x, y] = pointAt(i, radius + 22);
        const cos = Math.cos(angleAt(i));
        const anchor = Math.abs(cos) < 0.3 ? "middle" : cos > 0 ? "start" : "end";
        return (
          <text
            key={w.id}
            x={x.toFixed(1)}
            y={y.toFixed(1)}
            textAnchor={anchor}
            dominantBaseline="middle"
            fontSize={11}
            fill="var(--muted, #a89578)"
          >
            {w.label}
          </text>
        );
      })}
    </svg>
  );
}
