import Link from "next/link";
import { Star } from "lucide-react";
import { FlavorChip } from "@/components/flavor-chip";
import { UserAvatar } from "@/components/user-avatar";
import { isValidLeaf, leafLabel, wedgeForLeaf } from "@/lib/flavor-wheel";
import { compareFlavorNotes, type FlavorCompareGroup } from "@/lib/flavor-compare";

/** docs/DESIGN.md's calibration buckets — never red/green, a reference point not an answer key. */
const BUCKET_COLOR = {
  shared: "var(--taste-shared)",
  blind: "var(--taste-blind)",
  signature: "var(--taste-signature)",
} as const;

function BucketChipList({ groups, color }: { groups: FlavorCompareGroup[]; color: string }) {
  if (groups.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {groups.flatMap((group) =>
        group.leafIds.map((leafId) => (
          <li key={leafId} className="chip flex items-center gap-1.5 px-2.5 py-1 text-xs">
            <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} aria-hidden />
            <span className="text-foreground/90">{leafLabel(leafId) ?? leafId}</span>
          </li>
        )),
      )}
    </ul>
  );
}

function PlainChipList({ tags }: { tags: Record<string, number> }) {
  const entries = Object.entries(tags);
  if (entries.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {entries.map(([leafId, intensity]) => (
        <li key={leafId}>
          <FlavorChip leafId={leafId} intensity={intensity} />
        </li>
      ))}
    </ul>
  );
}

/**
 * The highest-intensity pair of DIFFERENT leaves, in the SAME wedge, that the
 * viewer and a friend each named — the "where Sarah writes clove, you write
 * cinnamon" payoff (§7.4). Null when no such clean pair exists; never picks a
 * leaf both named (that's agreement, not a payoff) or a bare "they named a
 * wedge you didn't touch at all" (no viewer leaf to contrast against).
 */
function findPayoffPair(
  mine: Record<string, number> | null,
  theirs: Record<string, number> | null,
): { mineLeaf: string; theirsLeaf: string } | null {
  if (!mine || !theirs) return null;
  const mineByWedge = new Map<string, string[]>();
  for (const leafId of Object.keys(mine)) {
    const wedge = wedgeForLeaf(leafId);
    if (!wedge) continue;
    const list = mineByWedge.get(wedge) ?? [];
    list.push(leafId);
    mineByWedge.set(wedge, list);
  }

  let best: { mineLeaf: string; theirsLeaf: string; heat: number } | null = null;
  for (const [theirsLeaf, theirsIntensity] of Object.entries(theirs)) {
    const wedge = wedgeForLeaf(theirsLeaf);
    if (!wedge) continue;
    const candidates = mineByWedge.get(wedge);
    if (!candidates) continue;
    for (const mineLeaf of candidates) {
      if (mineLeaf === theirsLeaf) continue; // agreement, not a contrast
      const heat = (theirsIntensity ?? 0) + (mine[mineLeaf] ?? 0);
      if (!best || heat > best.heat || (heat === best.heat && theirsLeaf < best.theirsLeaf)) {
        best = { mineLeaf, theirsLeaf, heat };
      }
    }
  }
  return best ? { mineLeaf: best.mineLeaf, theirsLeaf: best.theirsLeaf } : null;
}

/**
 * The most-mentioned descriptor at least one friend named and at least one
 * didn't — "your friends split on X" (§7.4's fourth bucket). Needs 2+ friends
 * to mean anything; null when everyone agrees or nobody overlaps.
 */
function findContestedDescriptor(friends: SameDramFriendNote[]): string | null {
  if (friends.length < 2) return null;
  const counts = new Map<string, number>();
  for (const friend of friends) {
    const leaves = new Set(Object.keys(friend.flavorTags ?? {}).filter(isValidLeaf));
    for (const leafId of leaves) counts.set(leafId, (counts.get(leafId) ?? 0) + 1);
  }
  let best: { leafId: string; count: number } | null = null;
  for (const [leafId, count] of counts) {
    if (count === 0 || count >= friends.length) continue; // unanimous either way isn't contested
    if (!best || count > best.count || (count === best.count && leafId < best.leafId)) {
      best = { leafId, count };
    }
  }
  return best?.leafId ?? null;
}

export interface SameDramAuthor {
  userId: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
}

/** Serialized FriendBottleNote (src/lib/social.ts) crossing the server→client boundary. */
export interface SameDramFriendNote {
  author: SameDramAuthor;
  pourId: string;
  rating: number | null;
  createdAt: string;
  flavorTags: Record<string, number> | null;
}

export interface SameDramProducer {
  tags: Record<string, number>;
  sourceLabel: string;
  sourceUrl: string;
}

export interface SameDramProps {
  /** The viewer's own union tags on this bottle, across all their pours. */
  viewerTags: Record<string, number> | null;
  /** Only ever passed when hasPublishedProducerFlavorNotes() gated true. */
  producer: SameDramProducer | null;
  friends: SameDramFriendNote[];
  /** Whether the viewer has any tasting notes at all on this bottle. */
  hasViewerNotes: boolean;
}

/**
 * US-8: bottle-page comparison — you vs. the producer vs. your friends, in
 * the same flavor coordinate space (docs/SOCIAL.md §7.4). Never right/wrong:
 * a published tasting note is one opinion, and a friend's note is another.
 */
export function SameDram({ viewerTags, producer, friends, hasViewerNotes }: SameDramProps) {
  if (friends.length === 0) {
    if (!hasViewerNotes) return null;
    return (
      <section aria-label="Same Dram" className="flex flex-col gap-3">
        <h2 className="section-label">Same Dram</h2>
        <div className="card-flat p-4">
          <p className="text-sm text-muted">
            You&rsquo;re first to this one — none of your friends have tasted it yet.{" "}
            <Link href="/friends" className="text-accent hover:brightness-110 transition-[filter]">
              Find friends
            </Link>
          </p>
        </div>
      </section>
    );
  }

  const hasViewerTags = viewerTags != null && Object.keys(viewerTags).length > 0;
  const cmp = producer && hasViewerTags ? compareFlavorNotes(viewerTags, producer.tags) : null;
  const contestedLeafId = findContestedDescriptor(friends);

  return (
    <section aria-label="Same Dram" className="flex flex-col gap-4">
      <div>
        <p className="section-label">You · the label · your friends</p>
        <h2 className="font-display text-xl font-semibold mt-1">Same Dram</h2>
      </div>

      {hasViewerTags && (
        <div className="card flex flex-col gap-2 p-4">
          <h3 className="section-label">You</h3>
          {cmp ? (
            <div className="flex flex-col gap-2">
              <BucketChipList groups={cmp.both} color={BUCKET_COLOR.shared} />
              <BucketChipList groups={cmp.onlyMine} color={BUCKET_COLOR.signature} />
            </div>
          ) : (
            <PlainChipList tags={viewerTags as Record<string, number>} />
          )}
        </div>
      )}

      {producer && (
        <div className="card flex flex-col gap-2 p-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="section-label">The label</h3>
            <a
              href={producer.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="text-[11px] text-muted hover:text-foreground transition-colors"
            >
              {producer.sourceLabel}
            </a>
          </div>
          {cmp ? (
            <div className="flex flex-col gap-2">
              <BucketChipList groups={cmp.both} color={BUCKET_COLOR.shared} />
              <BucketChipList groups={cmp.onlyTheirs} color={BUCKET_COLOR.blind} />
            </div>
          ) : (
            <PlainChipList tags={producer.tags} />
          )}
        </div>
      )}

      <div className="flex flex-col gap-3">
        <h3 className="section-label">Friends</h3>
        <ul className="flex flex-col gap-2.5">
          {friends.map((friend) => {
            const payoff = findPayoffPair(viewerTags, friend.flavorTags);
            return (
              <li key={friend.author.userId} className="card-flat flex flex-col gap-2 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <UserAvatar
                      name={friend.author.displayName || friend.author.handle}
                      image={friend.author.avatarUrl}
                      size={26}
                    />
                    <Link
                      href={`/u/${friend.author.handle}`}
                      className="truncate text-sm font-medium hover:text-accent transition-colors"
                    >
                      @{friend.author.handle}
                    </Link>
                  </div>
                  {friend.rating != null && (
                    <span className="flex shrink-0 items-center gap-1 text-sm text-accent">
                      <Star size={12} fill="currentColor" aria-hidden /> {friend.rating.toFixed(1)}
                    </span>
                  )}
                </div>
                {friend.flavorTags && <PlainChipList tags={friend.flavorTags} />}
                {payoff && (
                  <p className="text-sm text-foreground/85">
                    Where <span className="font-medium">@{friend.author.handle}</span> writes{" "}
                    {leafLabel(payoff.theirsLeaf) ?? payoff.theirsLeaf}, you write{" "}
                    {leafLabel(payoff.mineLeaf) ?? payoff.mineLeaf}.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
        {contestedLeafId && (
          <p className="text-xs text-muted">
            Friends split on {leafLabel(contestedLeafId) ?? contestedLeafId} — some named it, some didn&apos;t.
          </p>
        )}
      </div>
    </section>
  );
}
