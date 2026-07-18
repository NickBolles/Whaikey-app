"use client";

import { useId } from "react";

const STAR_PATH =
  "M12 1.8l3.1 6.33 6.98.98-5.06 4.9 1.2 6.94L12 17.68l-6.22 3.27 1.2-6.94-5.06-4.9 6.98-.98L12 1.8z";

function Star({ size, fraction }: { size: number; fraction: number }) {
  const clipId = useId();
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      className="pointer-events-none block"
    >
      <defs>
        <clipPath id={clipId}>
          <rect x="0" y="0" width={24 * fraction} height="24" />
        </clipPath>
      </defs>
      <path d={STAR_PATH} fill="var(--border)" />
      {fraction > 0 && <path d={STAR_PATH} fill="var(--accent)" clipPath={`url(#${clipId})`} />}
    </svg>
  );
}

export interface StarRatingProps {
  /** 0.5-5 in half-star steps, or null for unrated. */
  value: number | null;
  onChange: (value: number) => void;
  /** Pixel size of each star (default 44 — thumb-sized). */
  size?: number;
}

/**
 * Five-star rating with half-star steps: tapping the left half of a star
 * sets n-0.5, the right half sets n. Each half is a real button for
 * keyboard and screen reader access.
 */
export function StarRating({ value, onChange, size = 44 }: StarRatingProps) {
  const current = value ?? 0;
  return (
    <div role="group" aria-label="Rating" className="flex items-center gap-1">
      {[1, 2, 3, 4, 5].map((n) => {
        const fraction = Math.max(0, Math.min(1, current - (n - 1)));
        return (
          <span key={n} className="relative inline-block" style={{ width: size, height: size }}>
            <Star size={size} fraction={fraction} />
            <button
              type="button"
              aria-label={`Rate ${n - 0.5} stars`}
              aria-pressed={current === n - 0.5}
              onClick={() => onChange(n - 0.5)}
              className="absolute inset-y-0 left-0 w-1/2 cursor-pointer rounded-l-md focus-visible:outline-2 focus-visible:outline-accent"
            />
            <button
              type="button"
              aria-label={`Rate ${n} stars`}
              aria-pressed={current === n}
              onClick={() => onChange(n)}
              className="absolute inset-y-0 right-0 w-1/2 cursor-pointer rounded-r-md focus-visible:outline-2 focus-visible:outline-accent"
            />
          </span>
        );
      })}
      <span className="ml-2 min-w-8 text-lg font-semibold text-accent" aria-live="polite">
        {value != null ? value.toFixed(1) : "—"}
      </span>
    </div>
  );
}
