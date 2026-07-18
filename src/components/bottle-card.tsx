import Link from "next/link";
import { CategoryChip } from "@/components/category-chip";

export interface BottleCardProps {
  bottle: {
    id: string;
    name: string;
    category: string;
    distillery: string | null;
    region?: string | null;
    ageYears: number | null;
    abv: number | null;
    avgPrice: number | null;
  };
}

/** Compact search-result / list row linking to the bottle detail page. */
export function BottleCard({ bottle }: BottleCardProps) {
  const origin = [bottle.distillery, bottle.region ?? null].filter(Boolean).join(" · ");
  const specs = [
    bottle.ageYears != null ? `${bottle.ageYears} yr` : null,
    bottle.abv != null ? `${bottle.abv}% ABV` : null,
  ].filter(Boolean);

  return (
    <Link
      href={`/bottles/${bottle.id}`}
      className="card-flat flex items-center justify-between gap-3 p-4 hover:bg-surface-raised transition-colors"
    >
      <div className="min-w-0">
        <div className="font-medium text-foreground truncate">{bottle.name}</div>
        {origin && <div className="text-sm text-muted truncate mt-0.5">{origin}</div>}
        <div className="mt-2.5 flex items-center gap-2 text-xs text-muted">
          <CategoryChip category={bottle.category} />
          {specs.length > 0 && <span>{specs.join(" · ")}</span>}
        </div>
      </div>
      {bottle.avgPrice != null && (
        <div className="shrink-0 text-right">
          <div className="stat-number text-xl leading-none text-accent">
            ${Math.round(bottle.avgPrice)}
          </div>
          <div className="text-[10px] text-muted uppercase tracking-[0.14em] mt-1.5">avg</div>
        </div>
      )}
    </Link>
  );
}
