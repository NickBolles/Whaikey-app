import Link from "next/link";
import { BottleStamps } from "@/components/bottle-stamps";
import { CategoryChip } from "@/components/category-chip";
import { originLabel } from "@/lib/origin";

export interface BottleCardProps {
  bottle: {
    id: string;
    name: string;
    category: string;
    distillery: string | null;
    region?: string | null;
    country?: string | null;
    ageYears: number | null;
    abv: number | null;
    avgPrice: number | null;
  };
}

/** Compact search-result / list row linking to the bottle detail page. */
export function BottleCard({ bottle }: BottleCardProps) {
  const origin = [bottle.distillery, originLabel(bottle.region, bottle.country)]
    .filter(Boolean)
    .join(" · ");
  const specs = [
    bottle.ageYears != null ? `${bottle.ageYears} yr` : null,
    bottle.abv != null ? `${bottle.abv}% ABV` : null,
  ].filter(Boolean);

  return (
    <Link
      href={`/bottles/${bottle.id}`}
      className="card-flat flex items-center gap-3 p-4 hover:bg-surface-raised transition-colors"
    >
      <div className="min-w-0 flex-1">
        <div className="font-medium text-foreground truncate">{bottle.name}</div>
        {origin && <div className="text-sm text-muted truncate mt-0.5">{origin}</div>}
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-muted">
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
      {/* The bottle's own passport stamps, on the card's outer edge. Not the
          leading slot — that belongs to a bottle shot or a distillery mark,
          and crests are no substitute for either. Not the identity line
          below the name either: a long category ("Single Malt Scotch") plus
          the specs already fills it, and three crests inline wrapped the
          specs onto a second line. Stacked out here the run costs the text
          one crest's width, and the price keeps the text it belongs to
          (src/components/bottle-stamps.tsx). */}
      <BottleStamps category={bottle.category} region={bottle.region} country={bottle.country} />
    </Link>
  );
}
