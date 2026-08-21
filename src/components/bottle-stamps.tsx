import type { ReactElement } from "react";
import type { PassportFamily } from "@/db/schema";
import { PassportBadgeIcon } from "@/components/passport-badge";

/**
 * The passport stamps a BOTTLE carries: its country, its region where the
 * catalog knows one, and its style — the same three crests the Passport mints
 * (src/components/passport-badge.tsx), in the same coarse-to-fine order the
 * badge wall uses, stacked down a card's trailing gutter.
 *
 * They live in a gutter rather than inline with the card's text because the
 * text lines have no width to spare: a long category ("Single Malt Scotch")
 * and the specs already fill the identity line, and three inline crests
 * wrapped it in two. Stacked, the run costs the text one crest's width.
 *
 * These are struck at tier 0, the unstruck die. A bottle card knows nothing
 * about who is looking at it, and a metal frame here would read as a tier the
 * viewer holds; the dull die says "this is what's on the label" and nothing
 * about anyone's progress. Numbers never appear — the crests are decorative
 * (`aria-hidden`), because every one of them is already named in the card's
 * own text, and a screen reader should not hear the origin twice.
 */

export interface BottleStampsProps {
  category: string;
  region?: string | null;
  country?: string | null;
  /** Crest width in px; the stack keeps the run one crest wide. */
  size?: number;
  className?: string;
}

export function BottleStamps({
  category,
  region,
  country,
  size = 20,
  className,
}: BottleStampsProps): ReactElement | null {
  const stamps: Array<{ family: PassportFamily; value: string }> = [];
  if (country) stamps.push({ family: "country", value: country });
  if (region) stamps.push({ family: "region", value: region });
  if (category) stamps.push({ family: "style", value: category });
  if (stamps.length === 0) return null;

  return (
    <span
      aria-hidden
      // Coarse crest on top. Each stands clear of the next — an overlapping
      // shingle reads as one crowded smudge at this size.
      className={`inline-flex shrink-0 flex-col items-center gap-1 ${className ?? ""}`}
    >
      {stamps.map((stamp) => (
        <PassportBadgeIcon
          key={`${stamp.family}:${stamp.value}`}
          family={stamp.family}
          value={stamp.value}
          tier={0}
          size={size}
        />
      ))}
    </span>
  );
}
