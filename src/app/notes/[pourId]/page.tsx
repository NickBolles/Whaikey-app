import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { Star } from "lucide-react";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { getSessionUser } from "@/lib/session";
import { getSocialNote, getSocialPrefs, listComments } from "@/lib/social";
import { getPour } from "@/lib/pours";
import { FLAVOR_WHEEL, leafLabel, wedgeForLeaf } from "@/lib/flavor-wheel";
import { UserAvatar } from "@/components/user-avatar";
import { ShareComparison } from "@/components/share-comparison";
import { CheersButton } from "@/components/cheers-button";
import { CommentThread, type SerializedComment } from "@/components/comment-thread";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ pourId: string }>; searchParams: Promise<{ replyFrom?: string }> };

const wedgeColor = new Map(FLAVOR_WHEEL.map((w) => [w.id, w.color]));

const VISIBILITY_LABEL: Record<string, string> = {
  private: "Only me",
  friends: "Friends",
  followers: "Followers",
  public: "Public",
};

export async function generateMetadata(): Promise<Metadata> {
  // Deliberately generic — resolving the real note here would mean fetching
  // (and shaping metadata around) social data before we know who's asking;
  // the page itself carries the identity check, and this is noindex either way.
  return { title: "Tasting note", robots: { index: false, follow: false } };
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Note detail (docs/SOCIAL.md US-9/US-12): comments + cheers on a single
 * visible pour. Signed-out visitors get a sign-in hero — never a fetch — so
 * a shared link can't be used to probe whether a pour exists.
 */
export default async function NotePage({ params, searchParams }: Props) {
  const { pourId } = await params;
  const { replyFrom } = await searchParams;
  const viewer = await getSessionUser();

  if (!viewer) {
    return (
      <div className="flex min-h-[60dvh] flex-col items-center justify-center gap-5 px-6 text-center">
        <div aria-hidden className="text-5xl drop-shadow-[0_0_24px_rgba(232,161,60,0.25)]">
          🥃
        </div>
        <div>
          <h1 className="font-display text-2xl font-semibold">A tasting note awaits</h1>
          <p className="mt-2 max-w-sm text-muted">Sign in to see this note and join the conversation.</p>
        </div>
        <Link href="/sign-in" className="btn-primary px-8 py-3">
          Sign in
        </Link>
      </div>
    );
  }

  const db = getDb();
  const note = await getSocialNote(db, viewer.id, pourId);
  if (!note) notFound();

  const isOwner = note.author.userId === viewer.id;
  // A post-pour handoff may reference only the viewer's own pour of this same
  // bottle. This protects the comment composer from becoming a way to attach
  // another person's private journal entry.
  const ownPour = replyFrom ? await getPour(db, viewer.id, replyFrom) : null;
  const initialDraft = ownPour && ownPour.pour.bottleId === note.bottleId ? `I just logged my take too: /notes/${ownPour.pour.id}` : "";

  // Same query pattern as src/app/s/[code]/page.tsx: union the viewer's own
  // flavor tags across every pour they've logged on this bottle.
  let comparisonBlock: React.ReactNode = null;
  if (!isOwner) {
    const viewerNoteRows = await db
      .select({ flavorTags: schema.tastingNotes.flavorTags })
      .from(schema.tastingNotes)
      .innerJoin(schema.pours, eq(schema.tastingNotes.pourId, schema.pours.id))
      .where(and(eq(schema.pours.userId, viewer.id), eq(schema.pours.bottleId, note.bottleId)));

    if (viewerNoteRows.length > 0) {
      const viewerFlavorTags: Record<string, number> = {};
      for (const row of viewerNoteRows) {
        for (const [leafId, intensity] of Object.entries(row.flavorTags ?? {})) {
          viewerFlavorTags[leafId] = Math.max(viewerFlavorTags[leafId] ?? 0, intensity);
        }
      }
      comparisonBlock = <ShareComparison mine={viewerFlavorTags} theirs={note.flavorTags} />;
    }
  }

  const [authorPrefs, rawComments] = await Promise.all([
    getSocialPrefs(db, note.author.userId),
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

  const noteParts = [
    ["Nose", note.nose],
    ["Palate", note.palate],
    ["Finish", note.finish],
  ].filter((part): part is [string, string] => Boolean(part[1]));

  const flavorLeafIds = Object.entries(note.flavorTags ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([leafId]) => leafId);

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-6 px-4 pb-24 pt-8">
      <header className="flex items-start gap-3">
        <UserAvatar name={note.author.displayName || note.author.handle} image={note.author.avatarUrl} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link href={`/u/${note.author.handle}`} className="font-medium transition-colors hover:text-accent">
              {note.author.displayName || `@${note.author.handle}`}
            </Link>
            <span className="text-sm text-muted">@{note.author.handle}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted">
            <span>{formatDate(note.createdAt)}</span>
            <span className="chip px-2 py-0.5 text-[10px] uppercase tracking-[0.08em]">
              {VISIBILITY_LABEL[note.visibility] ?? note.visibility}
            </span>
          </div>
        </div>
      </header>

      <article className="card flex flex-col gap-5 p-5">
        <div>
          <Link href={`/bottles/${note.bottleId}`} className="font-display text-2xl font-semibold leading-tight transition-colors hover:text-accent">
            {note.bottleName}
          </Link>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-muted">
            {note.rating != null && (
              <span className="flex items-center gap-1 text-accent">
                <Star size={15} fill="currentColor" aria-hidden /> {note.rating.toFixed(1)}
              </span>
            )}
            {note.servingStyle && <span className="capitalize">{note.servingStyle}</span>}
          </div>
        </div>

        {flavorLeafIds.length > 0 && (
          <div className="flex flex-col gap-2">
            <h2 className="section-label">Flavor notes</h2>
            <ul className="flex flex-wrap gap-1.5">
              {flavorLeafIds.map((leafId) => {
                const wedgeId = wedgeForLeaf(leafId);
                return (
                  <li key={leafId} className="chip flex items-center gap-1.5 px-2.5 py-1 text-xs">
                    <span
                      className="inline-block h-1.5 w-1.5 rounded-full"
                      style={{ backgroundColor: wedgeId ? wedgeColor.get(wedgeId) : "var(--muted)" }}
                      aria-hidden
                    />
                    {leafLabel(leafId) ?? leafId}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {noteParts.map(([label, value]) => (
          <section key={label}>
            <h2 className="section-label mb-1">{label}</h2>
            <p className="text-foreground/90">{value}</p>
          </section>
        ))}
        {note.freeform && (
          <blockquote className="border-l-2 border-accent/70 pl-4 font-display text-lg italic text-foreground/90">{note.freeform}</blockquote>
        )}
        {noteParts.length === 0 && !note.freeform && (
          <p className="text-muted">A moment from {note.author.displayName || `@${note.author.handle}`}&apos;s tasting journal.</p>
        )}
      </article>

      {comparisonBlock}

      <CheersButton pourId={note.pourId} initialCount={note.cheersCount} initialCheered={note.viewerCheered} disabled={isOwner} />

      <CommentThread
        pourId={note.pourId}
        initialComments={comments}
        viewerSignedIn
        viewerCanComment={authorPrefs.allowComments}
        isOwner={isOwner}
        viewerUserId={viewer.id}
        initialDraft={initialDraft}
      />
    </div>
  );
}
