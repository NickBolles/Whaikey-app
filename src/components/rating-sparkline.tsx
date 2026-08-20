/**
 * A quiet inline trend of one bottle's pour ratings, oldest → newest. Drawn on
 * the full 0.5–5 rating scale (never rescaled to the data) so a flat line
 * means a steady verdict and a climb means the bottle genuinely grew on you —
 * the shape can't exaggerate a half-star wobble into a cliff.
 *
 * One series, so no legend: the copper line is the history, the amber dot is
 * the latest pour, and the pour list beside it is the readable table of the
 * same data.
 */

const W = 320;
const H = 56;
const PAD_X = 8;
const PAD_Y = 8;
const RATING_MIN = 0.5;
const RATING_MAX = 5;

function points(ratings: number[]): Array<{ x: number; y: number }> {
  const span = ratings.length - 1;
  return ratings.map((rating, i) => {
    const clamped = Math.min(RATING_MAX, Math.max(RATING_MIN, rating));
    return {
      x: PAD_X + (span === 0 ? (W - 2 * PAD_X) / 2 : (i * (W - 2 * PAD_X)) / span),
      y: PAD_Y + (1 - (clamped - RATING_MIN) / (RATING_MAX - RATING_MIN)) * (H - 2 * PAD_Y),
    };
  });
}

export function RatingSparkline({ ratings }: { ratings: number[] }) {
  if (ratings.length < 2) return null;
  const pts = points(ratings);
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const area = `${line} L${pts[pts.length - 1].x.toFixed(1)} ${H - PAD_Y} L${pts[0].x.toFixed(1)} ${H - PAD_Y} Z`;
  const last = pts[pts.length - 1];

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="block h-14 w-full"
      role="img"
      data-testid="rating-sparkline"
      aria-label={`Rating trend across ${ratings.length} pours: ${ratings
        .map((r) => r.toFixed(1))
        .join(", ")}`}
    >
      {/* Hairline floor at the bottom of the rating scale, so the wash has a base. */}
      <line
        x1={PAD_X}
        y1={H - PAD_Y}
        x2={W - PAD_X}
        y2={H - PAD_Y}
        stroke="var(--border)"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
      <path d={area} fill="var(--accent)" fillOpacity={0.08} />
      <path
        d={line}
        fill="none"
        stroke="var(--accent-deep)"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      {pts.slice(0, -1).map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={2.5} fill="var(--accent-deep)" stroke="var(--surface-raised)" strokeWidth={1.5} />
      ))}
      {/* The latest pour is the one moment of full amber. */}
      <circle cx={last.x} cy={last.y} r={3.5} fill="var(--accent)" stroke="var(--surface-raised)" strokeWidth={2} />
    </svg>
  );
}
