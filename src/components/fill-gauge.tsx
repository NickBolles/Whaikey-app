import { useId } from "react";

/**
 * Bottle outline in a 24x60 viewBox: neck from y=2, shoulders flare out to the
 * body by y=16, rounded base at y~57.5.
 */
const BOTTLE_PATH =
  "M9.5 2 h5 v6 c0 2.5 4.5 3.5 4.5 8 v39 a2.5 2.5 0 0 1 -2.5 2.5 h-9 A2.5 2.5 0 0 1 5 55 V16 c0 -4.5 4.5 -5.5 4.5 -8 Z";

/** Liquid can rise from the base (y=57.5) up into the neck (y=6) at 100%. */
const FILL_BOTTOM = 57.5;
const FILL_TOP = 6;

export interface FillGaugeProps {
  /** 0-100; null/undefined renders empty */
  level: number | null | undefined;
  className?: string;
}

/**
 * Small vertical bottle-shaped SVG gauge showing fill level as amber liquid.
 * Size it via className (e.g. "h-10 w-4"); the SVG scales to fit.
 */
export function FillGauge({ level, className }: FillGaugeProps) {
  const clipId = useId();
  const clamped = Math.max(0, Math.min(100, level ?? 0));
  const height = ((FILL_BOTTOM - FILL_TOP) * clamped) / 100;
  const y = FILL_BOTTOM - height;

  return (
    <svg
      viewBox="0 0 24 60"
      className={className}
      role="img"
      aria-label={`${Math.round(clamped)}% full`}
      data-testid="fill-gauge"
    >
      <defs>
        <clipPath id={clipId}>
          <path d={BOTTLE_PATH} />
        </clipPath>
      </defs>
      <path d={BOTTLE_PATH} fill="currentColor" opacity={0.08} />
      <rect
        x="3"
        y={y}
        width="18"
        height={height}
        fill="#d98324"
        clipPath={`url(#${clipId})`}
        data-testid="fill-gauge-fill"
      />
      <path
        d={BOTTLE_PATH}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.4}
        strokeWidth="1.5"
      />
    </svg>
  );
}
