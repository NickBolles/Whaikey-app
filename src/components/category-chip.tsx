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

export function CategoryChip({ category }: { category: string }) {
  return (
    <span className="inline-flex items-center rounded-full border border-border-subtle bg-surface-raised px-2 py-0.5 text-xs font-medium text-accent whitespace-nowrap">
      {categoryLabel(category)}
    </span>
  );
}
