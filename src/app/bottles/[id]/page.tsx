import Link from "next/link";
import { notFound } from "next/navigation";
import { Flame, Martini, UtensilsCrossed, type LucideIcon } from "lucide-react";
import { getDb } from "@/db";
import type { Pairing } from "@/db/schema";
import { getSessionUser } from "@/lib/session";
import { getBottleDetail } from "@/lib/search";
import { CategoryChip } from "@/components/category-chip";
import { FlavorRadar } from "@/components/flavor-radar";
import { ShelfActions } from "./shelf-actions";

export const dynamic = "force-dynamic";

const PAIRING_HEADINGS: Record<Pairing["pairingType"], string> = {
  food: "Food",
  cigar: "Cigars",
  cocktail: "Cocktails",
};

const PAIRING_ICONS: Record<Pairing["pairingType"], LucideIcon> = {
  food: UtensilsCrossed,
  cigar: Flame,
  cocktail: Martini,
};

const RELATIONSHIP_SUMMARY: Record<string, string> = {
  own: "This bottle is on your shelf.",
  tried: "You've tried this one.",
  wishlist: "This bottle is on your wishlist.",
};

function SmallStars({ rating }: { rating: number }) {
  return (
    <div aria-hidden className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => {
        const fraction = Math.max(0, Math.min(1, rating - (n - 1)));
        return (
          <svg key={n} viewBox="0 0 24 24" width={13} height={13} className="block">
            <path
              d="M12 1.8l3.1 6.33 6.98.98-5.06 4.9 1.2 6.94L12 17.68l-6.22 3.27 1.2-6.94-5.06-4.9 6.98-.98L12 1.8z"
              fill="var(--border)"
            />
            {fraction > 0 && (
              <path
                d="M12 1.8l3.1 6.33 6.98.98-5.06 4.9 1.2 6.94L12 17.68l-6.22 3.27 1.2-6.94-5.06-4.9 6.98-.98L12 1.8z"
                fill="var(--accent)"
                style={{ clipPath: `inset(0 ${((1 - fraction) * 100).toFixed(0)}% 0 0)` }}
              />
            )}
          </svg>
        );
      })}
    </div>
  );
}

export default async function BottleDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getSessionUser();
  const detail = await getBottleDetail(getDb(), id, user?.id);
  if (!detail) notFound();

  const { bottle, distillery, communityStats, userBottle, pairings } = detail;

  const metaParts = [
    bottle.region ?? distillery?.region ?? null,
    bottle.ageYears != null ? `${bottle.ageYears} years` : null,
    bottle.abv != null ? `${bottle.abv}% ABV` : null,
    bottle.caskTypes && bottle.caskTypes.length > 0 ? bottle.caskTypes.join(" + ") : null,
  ].filter(Boolean);

  const pairingGroups = (["food", "cigar", "cocktail"] as const)
    .map((type) => ({ type, rows: pairings.filter((p) => p.pairingType === type) }))
    .filter((g) => g.rows.length > 0);

  return (
    <div className="px-4 pt-6 pb-10 flex flex-col gap-6">
      {/* Hero */}
      <header>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="font-display text-[2rem] leading-[1.1] font-semibold tracking-tight">
              {bottle.name}
            </h1>
            {distillery && <p className="text-muted mt-1.5">{distillery.name}</p>}
          </div>
          <div className="mt-1.5">
            <CategoryChip category={bottle.category} active />
          </div>
        </div>
        {metaParts.length > 0 && (
          <p className="text-sm text-muted mt-2.5">{metaParts.join(" · ")}</p>
        )}
      </header>

      {/* Price row */}
      {(bottle.msrp != null || bottle.avgPrice != null) && (
        <section aria-label="Prices" className="grid grid-cols-2 gap-3">
          <div className="card p-4">
            <div className="stat-number text-2xl leading-none">
              {bottle.msrp != null ? `$${bottle.msrp.toFixed(0)}` : "—"}
            </div>
            <div className="text-[11px] text-muted mt-2 uppercase tracking-[0.14em]">MSRP</div>
          </div>
          <div className="card p-4">
            <div className="stat-number text-2xl leading-none text-accent">
              {bottle.avgPrice != null ? `$${bottle.avgPrice.toFixed(0)}` : "—"}
            </div>
            <div className="text-[11px] text-muted mt-2 uppercase tracking-[0.14em]">
              avg street price
            </div>
          </div>
        </section>
      )}

      {/* Description */}
      {bottle.description && (
        <p className="border-l-2 border-accent/40 pl-4 font-display italic text-[15px] leading-relaxed text-foreground/75">
          {bottle.description}
        </p>
      )}

      {/* Flavor profile */}
      <section aria-label="Flavor profile">
        <h2 className="section-label mb-3">Flavor profile</h2>
        <div className="card flex justify-center p-4">
          <FlavorRadar profile={bottle.flavorProfile} />
        </div>
      </section>

      {/* Community rating */}
      <section aria-label="Community rating" className="card p-5">
        {communityStats.avgRating != null ? (
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="stat-number text-4xl leading-none text-accent">
                {communityStats.avgRating.toFixed(1)}
              </span>
              <div className="flex flex-col gap-1.5">
                <SmallStars rating={communityStats.avgRating} />
                <span className="text-[11px] text-muted uppercase tracking-[0.14em]">out of 5</span>
              </div>
            </div>
            <span className="text-sm text-muted text-right">
              {communityStats.ratingCount} rated pour{communityStats.ratingCount === 1 ? "" : "s"}
            </span>
          </div>
        ) : (
          <span className="text-sm text-muted">
            No community ratings yet — pour one and be first.
          </span>
        )}
      </section>

      {/* Your shelf */}
      <section aria-label="Your shelf">
        <h2 className="section-label mb-3">Your shelf</h2>
        <div className="card p-5 flex flex-col gap-4">
          {user ? (
            <>
              <p className="text-sm text-muted">
                {userBottle
                  ? RELATIONSHIP_SUMMARY[userBottle.relationship] ?? "On your shelf."
                  : "Not on your shelf yet."}
                {userBottle?.status ? ` Status: ${userBottle.status}.` : ""}
              </p>
              <ShelfActions bottleId={bottle.id} current={userBottle?.relationship ?? null} />
            </>
          ) : (
            <p className="text-sm text-muted">
              <Link href="/sign-in" className="text-accent hover:underline">
                Sign in
              </Link>{" "}
              to add this bottle to your bar, tried list, or wishlist.
            </p>
          )}
        </div>
      </section>

      {/* Pairings */}
      {pairingGroups.length > 0 && (
        <section aria-label="Pairings">
          <h2 className="section-label mb-3">Pairings</h2>
          <div className="flex flex-col gap-5">
            {pairingGroups.map((group) => {
              const Icon = PAIRING_ICONS[group.type];
              return (
                <div key={group.type}>
                  <h3 className="text-[13px] font-medium text-foreground/80 mb-2">
                    {PAIRING_HEADINGS[group.type]}
                  </h3>
                  <ul className="flex flex-col gap-2.5">
                    {group.rows.map((p) => (
                      <li key={p.id} className="card flex items-start gap-3 p-4">
                        <Icon
                          size={18}
                          strokeWidth={1.8}
                          aria-hidden
                          className="shrink-0 mt-0.5 text-muted"
                        />
                        <div className="min-w-0">
                          <div className="font-medium text-sm">{p.suggestion}</div>
                          {p.rationale && (
                            <div className="text-[13px] text-muted mt-1 leading-relaxed">
                              {p.rationale}
                            </div>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
