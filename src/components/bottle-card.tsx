import Link from "next/link";
import { CategoryChip } from "@/components/category-chip";

export interface BottleCardProps {
  bottle: {
    id: string;
    name: string;
    category: string;
    distillery: string | null;
    ageYears: number | null;
    abv: number | null;
    avgPrice: number | null;
  };
}

/** Compact search-result / list card linking to the bottle detail page. */
export function BottleCard({ bottle }: BottleCardProps) {
  const specs = [
    bottle.ageYears != null ? `${bottle.ageYears} yr` : null,
    bottle.abv != null ? `${bottle.abv}% ABV` : null,
  ].filter(Boolean);

  return (
    <Link
      href={`/bottles/${bottle.id}`}
      className="flex items-start justify-between gap-3 rounded-xl border border-border-subtle bg-surface p-4 hover:bg-surface-raised transition-colors"
    >
      <div className="min-w-0">
        <div className="font-medium text-foreground truncate">{bottle.name}</div>
        {bottle.distillery && (
          <div className="text-sm text-muted truncate">{bottle.distillery}</div>
        )}
        <div className="mt-2 flex items-center gap-2 text-xs text-muted">
          <CategoryChip category={bottle.category} />
          {specs.length > 0 && <span>{specs.join(" · ")}</span>}
        </div>
      </div>
      {bottle.avgPrice != null && (
        <div className="shrink-0 text-right">
          <div className="font-semibold text-accent">${Math.round(bottle.avgPrice)}</div>
          <div className="text-[10px] text-muted uppercase tracking-wide">avg</div>
        </div>
      )}
    </Link>
  );
}
