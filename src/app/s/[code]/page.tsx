import type { Metadata } from "next";
import { notFound } from "next/navigation";
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
  const viewer = await getSessionUser();
  if (viewer) {
    const db = getDb();
    const shareRow = await db.query.pourShares.findFirst({ where: eq(schema.pourShares.code, code) });
    const pourId = shareRow?.pourId ?? null;
    const isOwner = shareRow?.userId === viewer.id;

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
        viewerBlock = <WishlistCta bottleId={share.bottleId} initialRelationship={existing?.relationship ?? null} />;
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
