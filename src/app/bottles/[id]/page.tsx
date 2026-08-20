import Link from "next/link";
import { notFound } from "next/navigation";
import { eq, and } from "drizzle-orm";
import { Flame, Martini, UtensilsCrossed, type LucideIcon } from "lucide-react";
import { getDb, schema } from "@/db";
import type { Pairing } from "@/db/schema";
import { getSessionUser } from "@/lib/session";
import { getBottleDetail } from "@/lib/search";
import { getUserPalate } from "@/lib/palate-store";
import { tasteMatchPercent } from "@/lib/palate";
import { hasPublishedProducerFlavorNotes } from "@/lib/bar";
import { getFriendNotesForBottle } from "@/lib/social";
import { listPours } from "@/lib/pours";
import { CategoryChip } from "@/components/category-chip";
import { FlavorRadar } from "@/components/flavor-radar";
import { SameDram, type SameDramFriendNote, type SameDramProducer } from "@/components/same-dram";
import { SmallStars } from "@/components/small-stars";
import { ShelfActions } from "./shelf-actions";
import { ShelfDetails } from "./shelf-details";
import { YourPours, type YourPourItem } from "./your-pours";

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

/** The first line a pour's note has to offer, trimmed for an inline row. */
function pourSnippet(note: { nose: string | null; palate: string | null; finish: string | null; freeform: string | null } | null): string | null {
  if (!note) return null;
  const text = note.nose ?? note.palate ?? note.finish ?? note.freeform;
  if (!text) return null;
  return text.length > 90 ? `${text.slice(0, 90).trimEnd()}…` : text;
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

  // Personal taste-match: cosine similarity of the signed palate vs this
  // bottle's flavor profile. Null (hidden) for signed-out users, users with no
  // palate signal yet, or bottles without a flavor profile.
  let match: number | null = null;
  // Same Dram (US-8): the viewer's own union tags on this bottle, friends'
  // notes, and the producer column (only when attributed). Signed-out
  // viewers get none of this — the section is hidden entirely for them.
  let sameDram: { viewerTags: Record<string, number> | null; friends: SameDramFriendNote[]; hasViewerNotes: boolean } | null = null;
  // The viewer's full pour history on this bottle, for the Your Pours section.
  let yourPours: YourPourItem[] = [];
  if (user) {
    const db = getDb();
    const palate = await getUserPalate(db, user.id);
    match = tasteMatchPercent(palate.vector, bottle.flavorProfile, palate.sampleSize);

    const [viewerNoteRows, friendNotes, viewerPours] = await Promise.all([
      db
        .select({ flavorTags: schema.tastingNotes.flavorTags })
        .from(schema.tastingNotes)
        .innerJoin(schema.pours, eq(schema.tastingNotes.pourId, schema.pours.id))
        .where(and(eq(schema.pours.userId, user.id), eq(schema.pours.bottleId, bottle.id))),
      getFriendNotesForBottle(db, user.id, bottle.id),
      listPours(db, user.id, { bottleId: bottle.id, limit: 200 }),
    ]);

    yourPours = viewerPours.map((p) => ({
      id: p.id,
      rating: p.rating,
      servingStyle: p.servingStyle,
      amountMl: p.amountMl,
      createdAt: p.createdAt.toISOString(),
      snippet: pourSnippet(p.note),
    }));

    const viewerFlavorTags: Record<string, number> = {};
    for (const row of viewerNoteRows) {
      for (const [leafId, intensity] of Object.entries(row.flavorTags ?? {})) {
        viewerFlavorTags[leafId] = Math.max(viewerFlavorTags[leafId] ?? 0, intensity);
      }
    }

    sameDram = {
      viewerTags: Object.keys(viewerFlavorTags).length > 0 ? viewerFlavorTags : null,
      friends: friendNotes.map((f) => ({
        author: f.author,
        pourId: f.pourId,
        rating: f.rating,
        createdAt: f.createdAt.toISOString(),
        flavorTags: f.flavorTags,
      })),
      hasViewerNotes: viewerNoteRows.length > 0,
    };
  }

  const producer: SameDramProducer | null =
    hasPublishedProducerFlavorNotes(bottle) && bottle.producerFlavorTags
      ? {
          tags: bottle.producerFlavorTags,
          sourceLabel: bottle.producerFlavorSourceLabel as string,
          sourceUrl: bottle.producerFlavorSourceUrl as string,
        }
      : null;

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
        <div className="flex items-center justify-between gap-3 mb-3">
          <h2 className="section-label">Flavor profile</h2>
          {match != null && (
            <span className="chip chip-active px-3 py-1 text-xs font-medium">
              {match}% match for you
            </span>
          )}
        </div>
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

      {/* The viewer's own history with this bottle, beside the community's. */}
      {user && yourPours.length > 0 && <YourPours bottleId={bottle.id} pours={yourPours} />}

      {sameDram && (
        <>
          <SameDram
            viewerTags={sameDram.viewerTags}
            producer={producer}
            friends={sameDram.friends}
            hasViewerNotes={sameDram.hasViewerNotes}
          />
          {sameDram.hasViewerNotes && (
            <Link
              href={`/bottles/${bottle.id}/compare`}
              className="btn-secondary flex min-h-11 items-center justify-center px-4 text-sm font-medium"
            >
              Your note, compared →
            </Link>
          )}
        </>
      )}

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
              <div className="flex flex-col gap-2">
                <Link href={`/pour?bottleId=${bottle.id}`} className="btn-primary flex items-center justify-center px-4 py-3 text-sm font-medium">Log a pour</Link>
                <ShelfActions bottleId={bottle.id} current={userBottle?.relationship ?? null} />
              </div>
              {userBottle?.relationship === "own" && (
                <ShelfDetails
                  row={{
                    id: userBottle.id,
                    status: userBottle.status,
                    fillLevel: userBottle.fillLevel,
                    purchasePrice: userBottle.purchasePrice,
                    store: userBottle.store,
                    location: userBottle.location,
                    notes: userBottle.notes,
                  }}
                />
              )}
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
