import Link from "next/link";
import { notFound } from "next/navigation";
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

const RELATIONSHIP_SUMMARY: Record<string, string> = {
  own: "This bottle is on your shelf.",
  tried: "You've tried this one.",
  wishlist: "This bottle is on your wishlist.",
};

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
          <div>
            <h1 className="text-2xl font-bold leading-tight">{bottle.name}</h1>
            {distillery && <p className="text-muted mt-1">{distillery.name}</p>}
          </div>
          <CategoryChip category={bottle.category} />
        </div>
        {metaParts.length > 0 && (
          <p className="text-sm text-muted mt-2">{metaParts.join(" · ")}</p>
        )}
      </header>

      {/* Price row */}
      {(bottle.msrp != null || bottle.avgPrice != null) && (
        <section aria-label="Prices" className="grid grid-cols-2 gap-3">
          <div className="rounded-xl bg-surface border border-border-subtle p-4">
            <div className="text-xl font-bold">
              {bottle.msrp != null ? `$${bottle.msrp.toFixed(0)}` : "—"}
            </div>
            <div className="text-xs text-muted mt-1">MSRP</div>
          </div>
          <div className="rounded-xl bg-surface border border-border-subtle p-4">
            <div className="text-xl font-bold text-accent">
              {bottle.avgPrice != null ? `$${bottle.avgPrice.toFixed(0)}` : "—"}
            </div>
            <div className="text-xs text-muted mt-1">avg street price</div>
          </div>
        </section>
      )}

      {/* Description */}
      {bottle.description && (
        <p className="text-sm leading-relaxed text-foreground/90">{bottle.description}</p>
      )}

      {/* Flavor profile */}
      <section aria-label="Flavor profile">
        <h2 className="text-sm font-semibold text-muted uppercase tracking-wide mb-2">
          Flavor profile
        </h2>
        <div className="flex justify-center rounded-xl bg-surface border border-border-subtle p-4">
          <FlavorRadar profile={bottle.flavorProfile} />
        </div>
      </section>

      {/* Community rating */}
      <section
        aria-label="Community rating"
        className="rounded-xl bg-surface border border-border-subtle p-4 flex items-center justify-between"
      >
        {communityStats.avgRating != null ? (
          <>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold text-accent">
                ★ {communityStats.avgRating.toFixed(1)}
              </span>
              <span className="text-sm text-muted">/ 5</span>
            </div>
            <span className="text-sm text-muted">
              {communityStats.ratingCount} rated pour{communityStats.ratingCount === 1 ? "" : "s"}
            </span>
          </>
        ) : (
          <span className="text-sm text-muted">No community ratings yet — pour one and be first.</span>
        )}
      </section>

      {/* Your shelf */}
      <section aria-label="Your shelf">
        <h2 className="text-sm font-semibold text-muted uppercase tracking-wide mb-2">
          Your shelf
        </h2>
        <div className="rounded-xl bg-surface border border-border-subtle p-4 flex flex-col gap-3">
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
          <h2 className="text-sm font-semibold text-muted uppercase tracking-wide mb-2">
            Pairings
          </h2>
          <div className="flex flex-col gap-4">
            {pairingGroups.map((group) => (
              <div key={group.type}>
                <h3 className="text-sm font-semibold mb-1.5">{PAIRING_HEADINGS[group.type]}</h3>
                <ul className="flex flex-col gap-2">
                  {group.rows.map((p) => (
                    <li
                      key={p.id}
                      className="rounded-xl bg-surface border border-border-subtle p-3"
                    >
                      <div className="font-medium text-sm">{p.suggestion}</div>
                      {p.rationale && (
                        <div className="text-xs text-muted mt-1 leading-relaxed">{p.rationale}</div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
