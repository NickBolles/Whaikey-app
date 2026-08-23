import type { ReactElement } from "react";
import type { PassportFamily } from "@/db/schema";
import { PassportBadgeIcon } from "@/components/passport-badge";

/**
 * The passport stamps a BOTTLE carries: its country, its region where the
 * catalog knows one, and its style — the same three crests the Passport mints
 * (src/components/passport-badge.tsx), in the same coarse-to-fine order the
 * badge wall uses.
 *
 * Two layouts, because the surfaces differ in what they can spare:
 *
 * - `column` (the default) is the list-row rail — a bottle card's text lines
 *   have no width to spare, so the run stacks in a gutter and costs the text
 *   one crest's width instead of three (docs/DESIGN.md rule 11).
 * - `row` is for the bottle's own page, where the crests are the point rather
 *   than an aside and there is a full page width to lay them out in.
 *
 * These are struck at tier 0, the unstruck die. These surfaces describe the
 * bottle, not the viewer, and a real metal frame would read as a tier the
 * viewer holds; the dull die says "this is what's on the label" and nothing
 * about anyone's progress. Numbers never appear — the crests are decorative
 * (`aria-hidden`), because every one of them is already named in the text
 * beside it, and a screen reader should not hear the origin twice.
 */

export interface BottleStampsProps {
  category: string;
  region?: string | null;
  country?: string | null;
  /** Crest width in px; a column keeps the run one crest wide. */
  size?: number;
  /** "column" stacks the run in a gutter; "row" lays it out inline. */
  orientation?: "row" | "column";
  className?: string;
}

export function BottleStamps({
  category,
  region,
  country,
  size = 20,
  orientation = "column",
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
      // Coarse crest first. Each stands clear of the next — overlapped into a
      // shingle they read as one crowded smudge at these sizes.
      className={`inline-flex shrink-0 items-center gap-1 ${orientation === "column" ? "flex-col" : ""} ${className ?? ""}`}
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
