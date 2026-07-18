import type { WhiskeyCategory } from "@/db/schema";

export const CATEGORY_LABELS: Record<WhiskeyCategory, string> = {
  bourbon: "Bourbon",
  rye: "Rye",
  "american-single-malt": "American Single Malt",
  "american-other": "American Whiskey",
  "scotch-single-malt": "Single Malt Scotch",
  "scotch-blended": "Blended Scotch",
  irish: "Irish",
  japanese: "Japanese",
  canadian: "Canadian",
  world: "World",
};

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category as WhiskeyCategory] ?? category;
}

export function CategoryChip({
  category,
  active = false,
}: {
  category: string;
  /** Amber-tinted variant for the one place a screen highlights its category. */
  active?: boolean;
}) {
  return (
    <span
      className={`${active ? "chip chip-active" : "chip"} inline-flex items-center px-2.5 py-0.5 text-[11px] font-medium whitespace-nowrap`}
    >
      {categoryLabel(category)}
    </span>
  );
}
