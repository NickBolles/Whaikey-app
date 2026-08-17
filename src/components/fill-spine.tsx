/**
 * The vertical bottle-level indicator that stands in for bottle thumbnails in
 * lists: a slim track the height of its row, filled from the bottom with a
 * per-bottle brown. Give the parent row `items-stretch` and this
 * `self-stretch` so the spine spans the row.
 */

/** Warm bottle browns; one is picked per bottle so shelves read as varied glass. */
const TONES = ["#a5732f", "#8a5a2a", "#9c6b3f", "#b98d4f", "#7a4a22", "#8f6a35"] as const;

/** Deterministic per-bottle tone (stable across renders and sessions). */
export function spineTone(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return TONES[Math.abs(hash) % TONES.length];
}

export interface FillSpineProps {
  /** 0-100; null/undefined renders an empty track. */
  level: number | null | undefined;
  /** Fill color — pass spineTone(bottleId) for the per-bottle brown. */
  tone?: string;
  className?: string;
}

export function FillSpine({ level, tone, className }: FillSpineProps) {
  const clamped = Math.max(0, Math.min(100, level ?? 0));
  return (
    <div
      role="img"
      aria-label={`${Math.round(clamped)}% full`}
      data-testid="fill-spine"
      className={`relative w-[13px] shrink-0 overflow-hidden rounded-[4px] ${className ?? ""}`}
      style={{ backgroundColor: "#241d14" }}
    >
      <div
        data-testid="fill-spine-fill"
        className="absolute inset-x-0 bottom-0"
        style={{ height: `${clamped}%`, backgroundColor: tone ?? TONES[0] }}
      />
    </div>
  );
}
