import { useId } from "react";

/**
 * Bottle silhouette in a 28x64 viewBox: slim neck under a small cap, soft
 * sloping shoulders flaring into the body, rounded base at y~61.5.
 */
const BOTTLE_PATH =
  "M11 3 h6 v7.5 c0 3.6 7.5 4.8 7.5 11.5 v36 a3.5 3.5 0 0 1 -3.5 3.5 h-14 a3.5 3.5 0 0 1 -3.5 -3.5 V22 c0 -6.7 7.5 -7.9 7.5 -11.5 Z";

/** Liquid can rise from the base (y=61.5) up into the neck (y=7) at 100%. */
const FILL_BOTTOM = 61.5;
const FILL_TOP = 7;

export interface FillGaugeProps {
  /** 0-100; null/undefined renders empty */
  level: number | null | undefined;
  className?: string;
}

/**
 * Small vertical bottle-shaped SVG gauge showing fill level as amber liquid
 * with a lighter meniscus line at the surface. The outline picks up
 * `currentColor`, so set a muted text color on the parent (or via className).
 * Size it via className (e.g. "h-12 w-5"); the SVG scales to fit.
 */
export function FillGauge({ level, className }: FillGaugeProps) {
  const uid = useId();
  const clipId = `${uid}-clip`;
  const gradId = `${uid}-grad`;
  const clamped = Math.max(0, Math.min(100, level ?? 0));
  const height = ((FILL_BOTTOM - FILL_TOP) * clamped) / 100;
  const y = FILL_BOTTOM - height;

  return (
    <svg
      viewBox="0 0 28 64"
      className={className}
      role="img"
      aria-label={`${Math.round(clamped)}% full`}
      data-testid="fill-gauge"
    >
      <defs>
        <clipPath id={clipId}>
          <path d={BOTTLE_PATH} />
        </clipPath>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#e8a13c" />
          <stop offset="1" stopColor="#b96f1e" />
        </linearGradient>
      </defs>
      {/* cap */}
      <rect
        x="10.4"
        y="0.75"
        width="7.2"
        height="2.8"
        rx="1.1"
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.45}
        strokeWidth="1.2"
      />
      {/* glass interior */}
      <path d={BOTTLE_PATH} fill="currentColor" opacity={0.07} />
      <rect
        x="2"
        y={y}
        width="24"
        height={height}
        fill={`url(#${gradId})`}
        clipPath={`url(#${clipId})`}
        data-testid="fill-gauge-fill"
      />
      {clamped > 0 && (
        <rect
          x="2"
          y={y}
          width="24"
          height="1.8"
          fill="#f9d79a"
          opacity={0.9}
          clipPath={`url(#${clipId})`}
          data-testid="fill-gauge-meniscus"
        />
      )}
      <path
        d={BOTTLE_PATH}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.45}
        strokeWidth="1.5"
      />
    </svg>
  );
}
