import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { Star } from "lucide-react";
import { FlavorWheel } from "@/components/flavor-wheel";
import { ShareComparison } from "@/components/share-comparison";
import { CheersButton } from "@/components/cheers-button";
import { CommentThread, type SerializedComment } from "@/components/comment-thread";
import { rollUpToWedges } from "@/lib/flavor-wheel";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { getSessionUser } from "@/lib/session";
import { getPublicPourShare } from "@/lib/pour-sharing";
import { isAutomatedFetch, recordEvent, shareIdForCode } from "@/lib/observability/analytics";
import { getSocialNote, getSocialPrefs, listComments } from "@/lib/social";
import { WishlistCta } from "./wishlist-cta";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ code: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { code } = await params;
  const share = await getPublicPourShare(getDb(), code);
  if (!share) return { title: "Tasting note not found", robots: { index: false, follow: false } };
  const description = share.note.freeform ?? share.note.nose ?? share.note.palate ?? `A tasting note from ${share.ownerName}.`;
  return {
    title: `${share.bottleName} tasting note`,
    description,
    robots: { index: false, follow: false },
    openGraph: {
      title: `${share.ownerName}'s ${share.bottleName} tasting note`,
      description,
      images: [{ url: `/s/${share.code}/opengraph-image`, width: 1200, height: 630, alt: `${share.bottleName} tasting note` }],
    },
    twitter: { card: "summary_large_image", title: `${share.bottleName} tasting note`, description, images: [`/s/${share.code}/opengraph-image`] },
  };
}

export default async function SharedPourPage({ params }: Props) {
  const { code } = await params;
  const share = await getPublicPourShare(getDb(), code);
  if (!share) notFound();

  /**
   * PLAN-A5, the number that was supposed to gate S2 and never existed.
   *
   * Recorded here rather than in `getPublicPourShare`, which is also called by
   * `opengraph-image.tsx` — every link preview a chat app generates would
   * otherwise count as somebody reading the note, and the funnel would measure
   * crawlers. This runs where a person actually landed on the page.
   *
   * The row stores the share's **id**, never the code in the URL: a table of
   * live codes is a table of keys, which is the leak `Referrer-Policy` and the
   * CSP endpoint's redaction both exist to prevent.
   */
  const viewer = await getSessionUser();
  const shareRow = viewer
    ? await getDb().query.pourShares.findFirst({ where: eq(schema.pourShares.code, code) })
    : null;
  const shareId = shareRow?.id ?? (await shareIdForCode(getDb(), code));
  /**
   * The sharer opening their own link is not a reader (PLAN-A5).
   *
   * `/sharing` has a "View" button beside every link, and the owner branch
   * below deliberately renders no comparison — there is nothing to compare a
   * note against its own author. Counting those as signed-in views put a guaranteed
   * miss in the denominator of the overlap rate, so the metric would read as
   * sparse overlap in exact proportion to how often people checked their own
   * links. The number is about recipients; the owner is not one.
   */
  const viewerIsOwner = Boolean(viewer && shareRow?.userId === viewer.id);
  /**
   * And a preview crawler is not a reader either (PLAN-A5).
   *
   * Posting a link into a chat app makes that app fetch this page for its
   * Open Graph card, before any human has opened anything — so the shares
   * that travel furthest inflated `views` the most, and the number would have
   * grown with unfurls rather than with readers. `isAutomatedFetch` reads the
   * request's own prefetch headers and user-agent; see its docstring for why
   * the heuristic errs towards over-counting rather than dropping anyone real.
   */
  const automated = isAutomatedFetch(await headers());
  if (!viewerIsOwner && !automated) {
    await recordEvent(getDb(), "share_view", { userId: viewer?.id ?? null, shareId });
  }

  const noteParts = [["Nose", share.note.nose], ["Palate", share.note.palate], ["Finish", share.note.finish]].filter((part): part is [string, string] => Boolean(part[1]));
  const leafHeat = Object.fromEntries(Object.entries(share.note.flavorTags ?? {}).map(([id, intensity]) => [id, intensity / 3]));
  const wedgeHeat = Object.fromEntries(Object.entries(rollUpToWedges(share.note.flavorTags ?? {})).map(([id, intensity]) => [id, intensity / 10]));

  // Viewer-private block: computed only for a signed-in viewer, never shown to
  // (or stored for) the sharer, and never allowed to touch the card above.
  let viewerBlock: React.ReactNode = null;
  // The signed-in comment/cheers thread (docs/SOCIAL.md US-9/US-12) — only
  // when the bearer link's pour also clears the ordinary canViewPour check
  // for this viewer (getSocialNote non-null). A friends-visibility pour
  // shared with a link-holding stranger still 404s on the comment/cheers
  // APIs, so the thread never renders for them.
  let discussionBlock: React.ReactNode = null;
  if (viewer) {
    const db = getDb();
    const pourId = shareRow?.pourId ?? null;
    const isOwner = viewerIsOwner;

    if (isOwner) {
      viewerBlock = (
        <p className="text-center text-sm text-muted">
          This is your link ·{" "}
          <Link href="/sharing" className="text-accent hover:brightness-110 transition-[filter]">
            manage shared links
          </Link>
        </p>
      );
    } else {
      const socialNote = pourId ? await getSocialNote(db, viewer.id, pourId) : null;

      const viewerNotes = await db
        .select({ flavorTags: schema.tastingNotes.flavorTags })
        .from(schema.tastingNotes)
        .innerJoin(schema.pours, eq(schema.tastingNotes.pourId, schema.pours.id))
        .where(and(eq(schema.pours.userId, viewer.id), eq(schema.pours.bottleId, share.bottleId)));

      if (viewerNotes.length > 0) {
        // Multiple pours of the same bottle: union the viewer's own tags,
        // matching how getFlavorCalibration treats repeat pours.
        const viewerFlavorTags: Record<string, number> = {};
        for (const note of viewerNotes) {
          for (const [leafId, intensity] of Object.entries(note.flavorTags ?? {})) {
            viewerFlavorTags[leafId] = Math.max(viewerFlavorTags[leafId] ?? 0, intensity);
          }
        }
        /**
         * The second step of the funnel: a signed-in viewer who has poured
         * this bottle themselves, so there is something to compare. The gap
         * between this and `share_view` IS the sparse-overlap risk S1 was
         * meant to test.
         *
         * `!automated` for the same reason as the view above, and the omission
         * was worse than a missed filter: `comparisonRate` divides this by
         * signed-in views, so suppressing the denominator while recording the
         * numerator let an authenticated prefetch push the rate ABOVE 100%.
         * That is the identical defect as the earlier `blockRate` finding — a
         * numerator drawn from a wider population than its denominator — and I
         * reintroduced it one event later while fixing the first one.
         */
        if (!automated) {
          await recordEvent(getDb(), "share_comparison_rendered", {
            userId: viewer.id,
            shareId,
          });
        }
        viewerBlock = (
          <div className="flex flex-col gap-2">
            <ShareComparison mine={viewerFlavorTags} theirs={share.note.flavorTags} />
            {socialNote && pourId && (
              <Link
                href={`/notes/${pourId}`}
                className="self-end text-sm text-accent transition-[filter] hover:brightness-110"
              >
                Open discussion →
              </Link>
            )}
          </div>
        );
      } else {
        const existing = await db.query.userBottles.findFirst({
          where: and(eq(schema.userBottles.userId, viewer.id), eq(schema.userBottles.bottleId, share.bottleId)),
        });
        viewerBlock = (
          <WishlistCta
            bottleId={share.bottleId}
            initialRelationship={existing?.relationship ?? null}
            fromShareId={shareId}
          />
        );
      }

      if (socialNote && pourId) {
        const [authorPrefs, rawComments] = await Promise.all([
          getSocialPrefs(db, socialNote.author.userId),
          listComments(db, viewer.id, pourId),
        ]);
        const comments: SerializedComment[] = (rawComments ?? []).map((comment) => ({
          id: comment.id,
          pourId: comment.pourId,
          parentId: comment.parentId,
          author: comment.author,
          body: comment.body,
          createdAt: comment.createdAt.toISOString(),
          editedAt: comment.editedAt ? comment.editedAt.toISOString() : null,
          deleted: comment.deleted,
          canEdit: comment.canEdit,
          canDelete: comment.canDelete,
        }));
        discussionBlock = (
          <section className="flex flex-col gap-4">
            <CheersButton pourId={pourId} initialCount={socialNote.cheersCount} initialCheered={socialNote.viewerCheered} />
            <CommentThread
              pourId={pourId}
              initialComments={comments}
              viewerSignedIn
              viewerCanComment={authorPrefs.allowComments}
              isOwner={false}
              viewerUserId={viewer.id}
            />
          </section>
        );
      } else if (shareRow) {
        const sharerProfile = await db.query.userProfiles.findFirst({
          where: eq(schema.userProfiles.userId, shareRow.userId),
        });
        if (sharerProfile?.socialEnabled) {
          discussionBlock = (
            <p className="text-center text-sm text-muted">
              Comparisons stay private to you.{" "}
              <Link href={`/u/${sharerProfile.handle}`} className="text-accent transition-[filter] hover:brightness-110">
                Follow @{sharerProfile.handle} to discuss.
              </Link>
            </p>
          );
        }
      }
    }
  }

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-6 px-4 py-12">
      <header className="space-y-2">
        <p className="section-label">Shared from Whaikey</p>
        <h1 className="font-display text-4xl font-semibold leading-tight">{share.bottleName}</h1>
        <p className="text-muted">{share.ownerName}&apos;s tasting note</p>
      </header>
      <article className="card flex flex-col gap-5 p-5">
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
          {share.pour.rating != null && <span className="flex items-center gap-1 text-accent"><Star size={15} fill="currentColor" aria-hidden /> {share.pour.rating.toFixed(1)}</span>}
          {share.pour.servingStyle && <span className="capitalize">{share.pour.servingStyle}</span>}
          {/* Pour size is deliberately not shown: a volume metric never renders
              to another user, even on an opt-in share (docs/SOCIAL.md §3.1). */}
          {share.locationLabel && <span>at {share.locationLabel}</span>}
        </div>
        {Object.keys(leafHeat).length > 0 && (
          <section className="flex flex-col items-center gap-2">
            <h2 className="section-label self-start">Tasting wheel</h2>
            <FlavorWheel wedgeHeat={wedgeHeat} leafHeat={leafHeat} caption="Flavor notes" subCaption="from this pour" />
          </section>
        )}
        {noteParts.map(([label, value]) => <section key={label}><h2 className="section-label mb-1">{label}</h2><p className="text-foreground/90">{value}</p></section>)}
        {share.note.freeform && <blockquote className="border-l-2 border-accent/70 pl-4 font-display text-lg italic text-foreground/90">{share.note.freeform}</blockquote>}
        {noteParts.length === 0 && !share.note.freeform && <p className="text-muted">A moment from {share.ownerName}&apos;s tasting journal.</p>}
      </article>
      <p className="text-center text-xs text-muted">Shared intentionally by its author · Whaikey</p>
      {viewerBlock}
      {discussionBlock}
    </div>
  );
}
