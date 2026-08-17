import Link from "next/link";
import { topFlavorTags } from "@/lib/flavor-wheel";
import { FillSpine, spineTone } from "@/components/fill-spine";
import { FlavorChip } from "@/components/flavor-chip";

export interface BottleListRowProps {
  href: string;
  name: string;
  /** Personal score (5-point scale), right-aligned on the name's baseline. */
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
}

/**
 * The compact bottle reference used by My Bar and other bottle lists: fill
 * spine, name with the personal score on its baseline, meta line, and the
 * drinker's own top flavor chips. The whole row is one tap target to the
 * bottle detail page — no separate chevron, no placeholder chips.
 */
export function BottleListRow({
  href,
  name,
  score,
  meta,
  metaRight,
  spine,
  flavorTags,
}: BottleListRowProps) {
  const chips = topFlavorTags(flavorTags, 3);
  return (
    <Link
      href={href}
      data-testid="bottle-list-row"
      className="flex items-stretch gap-[13px] rounded-2xl border px-3.5 py-3 transition-colors hover:bg-surface-raised/60"
      style={{ borderColor: "#2e2519", background: "rgba(244,236,221,.03)" }}
    >
      {spine && <FillSpine level={spine.level} tone={spineTone(spine.bottleId)} className="self-stretch" />}
      <span className="flex min-w-0 flex-1 flex-col justify-center gap-[7px]">
        <span className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 truncate text-[14.5px] font-semibold leading-[1.25]">
            {name}
          </span>
          {score != null && (
            <span className="shrink-0 font-mono text-[13px] font-semibold text-accent">
              {score.toFixed(1)}
            </span>
          )}
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
    </Link>
  );
}
