const STAR_PATH =
  "M12 1.8l3.1 6.33 6.98.98-5.06 4.9 1.2 6.94L12 17.68l-6.22 3.27 1.2-6.94-5.06-4.9 6.98-.98L12 1.8z";

/** A read-only row of five 13px stars, filled fractionally to `rating`. */
export function SmallStars({ rating }: { rating: number }) {
  return (
    <div aria-hidden className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => {
        const fraction = Math.max(0, Math.min(1, rating - (n - 1)));
        return (
          <svg key={n} viewBox="0 0 24 24" width={13} height={13} className="block">
            <path d={STAR_PATH} fill="var(--border)" />
            {fraction > 0 && (
              <path
                d={STAR_PATH}
                fill="var(--accent)"
                style={{ clipPath: `inset(0 ${((1 - fraction) * 100).toFixed(0)}% 0 0)` }}
              />
            )}
          </svg>
        );
      })}
    </div>
  );
}
