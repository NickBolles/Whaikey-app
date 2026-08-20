import Link from "next/link";
import { topFlavorTags } from "@/lib/flavor-wheel";
import { FillSpine, spineTone } from "@/components/fill-spine";
import { FlavorChip } from "@/components/flavor-chip";

export interface BottleListRowPours {
  /** Every pour of this bottle, rated or not. */
  count: number;
  /** Lowest / highest rating given; null until a pour is rated. */
  ratingMin?: number | null;
  ratingMax?: number | null;
}

export interface BottleListRowProps {
  href: string;
  name: string;
  /** Personal score: the mean of this drinker's pour ratings (5-point scale). */
  score?: number | null;
  /** Left half of the meta line, e.g. "Islay · 43%". */
  meta?: string | null;
  /** Right half of the meta line, e.g. "72% left". */
  metaRight?: string | null;
  /**
   * Bottle-level spine replacing a thumbnail. Pass the fill level and the
   * bottle id (for its per-bottle tone); omit for rows without a fill
   * (wishlist, tried).
   */
  spine?: { level: number | null | undefined; bottleId: string } | null;
  /** YOUR tags on this bottle — the top 3 by intensity render as chips. */
  flavorTags?: Record<string, number> | null;
  /** Pour-history summary; omit (or count 0) for untouched bottles. */
  pours?: BottleListRowPours | null;
}

/**
 * The compact bottle reference used by My Bar and other bottle lists: fill
 * spine, name and meta, the drinker's own top flavor chips, and a right-hand
 * rating block — mean score over their pour ratings, the min–max range when
 * pours disagree, and how many pours that verdict rests on. The whole row is
 * one tap target to the bottle detail page — no separate chevron, no
 * placeholder chips.
 */
export function BottleListRow({
  href,
  name,
  score,
  meta,
  metaRight,
  spine,
  flavorTags,
  pours,
}: BottleListRowProps) {
  const chips = topFlavorTags(flavorTags, 3);
  const pourCount = pours?.count ?? 0;
  // A range is only information when two rated pours actually disagree.
  const range =
    pours?.ratingMin != null && pours?.ratingMax != null && pours.ratingMin < pours.ratingMax
      ? { min: pours.ratingMin, max: pours.ratingMax }
      : null;
  const hasRatingBlock = score != null || pourCount > 0;
  return (
    <Link
      href={href}
      data-testid="bottle-list-row"
      className="flex items-stretch gap-[13px] rounded-2xl border px-3.5 py-3 transition-colors hover:bg-surface-raised/60"
      style={{ borderColor: "#2e2519", background: "rgba(244,236,221,.03)" }}
    >
      {spine && <FillSpine level={spine.level} tone={spineTone(spine.bottleId)} className="self-stretch" />}
      <span className="flex min-w-0 flex-1 flex-col justify-center gap-[7px]">
        <span className="min-w-0 truncate text-[14.5px] font-semibold leading-[1.25]">
          {name}
        </span>
        {(meta || metaRight) && (
          <span className="flex items-baseline justify-between gap-3 text-xs text-muted">
            <span className="min-w-0 truncate">{meta}</span>
            {metaRight && <span className="shrink-0">{metaRight}</span>}
          </span>
        )}
        {chips.length > 0 && (
          <span className="flex flex-wrap gap-1.5">
            {chips.map((c) => (
              <FlavorChip key={c.leafId} leafId={c.leafId} />
            ))}
          </span>
        )}
      </span>
      {hasRatingBlock && (
        <span
          className="flex shrink-0 flex-col items-end justify-center gap-1 text-right"
          aria-label={ratingBlockLabel(score, pourCount, range)}
        >
          {score != null && (
            <span aria-hidden className="font-mono text-[15px] font-semibold leading-none text-accent">
              {score.toFixed(1)}
            </span>
          )}
          {range && (
            <span aria-hidden className="font-mono text-[10px] leading-none text-muted tabular-nums">
              {range.min.toFixed(1)}–{range.max.toFixed(1)}
            </span>
          )}
          {pourCount > 0 && (
            <span aria-hidden className="text-[10px] leading-none text-muted">
              {pourCount} pour{pourCount === 1 ? "" : "s"}
            </span>
          )}
        </span>
      )}
    </Link>
  );
}

function ratingBlockLabel(
  score: number | null | undefined,
  pourCount: number,
  range: { min: number; max: number } | null,
): string {
  const parts: string[] = [];
  if (score != null) parts.push(`Rated ${score.toFixed(1)} out of 5`);
  if (range) parts.push(`ranging ${range.min.toFixed(1)} to ${range.max.toFixed(1)}`);
  if (pourCount > 0) parts.push(`over ${pourCount} pour${pourCount === 1 ? "" : "s"}`);
  return parts.join(", ");
}
