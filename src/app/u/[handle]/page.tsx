import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { GlassWater, Lock, Star } from "lucide-react";
import { getDb } from "@/db";
import { getSessionUser } from "@/lib/session";
import { getProfileView, type SocialNote } from "@/lib/social";
import { getPalateMatch } from "@/lib/taste-twins";
import { FLAVOR_WHEEL, leafLabel, wedgeForLeaf } from "@/lib/flavor-wheel";
import { categoryLabel } from "@/components/category-chip";
import { FlavorWheel } from "@/components/flavor-wheel";
import { PalateMatchChip } from "@/components/palate-match-chip";
import { UserAvatar } from "@/components/user-avatar";
import { ProfileEditor } from "./profile-editor";
import { FollowBlockActions } from "./follow-block-actions";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ handle: string }> };

const wedgeColor = new Map(FLAVOR_WHEEL.map((w) => [w.id, w.color]));

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { handle } = await params;
  return { title: `@${handle}`, robots: { index: false, follow: false } };
}

export default async function ProfilePage({ params }: Props) {
  const { handle } = await params;
  const viewer = await getSessionUser();
  const view = await getProfileView(getDb(), viewer?.id ?? null, handle);
  if (!view) notFound();

  const { profile, palate, recentNotes, viewerState } = view;
  const signedIn = Boolean(viewer);
  // US-16: how closely this person tastes like the viewer. Null — and so
  // absent — unless the viewer follows them and both palates carry enough
  // rated pours to mean something.
  const palateMatch = await getPalateMatch(getDb(), viewer?.id ?? null, profile.userId);
  // Mirrors getProfileView's own canSeeContent gate (docs/SOCIAL.md US-4): a
  // signed-out viewer never sees content, even for a public profile.
  const canSeeContent = signedIn && (viewerState.isSelf || profile.isPublic || viewerState.followState === "accepted");

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-6 px-4 pb-24 pt-8">
      {viewerState.isSelf ? (
        <ProfileEditor profile={profile} />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <UserAvatar name={profile.displayName || profile.handle} image={profile.avatarUrl} size={64} />
            <div>
              <h1 className="font-display text-2xl font-semibold leading-tight">
                {profile.displayName || `@${profile.handle}`}
              </h1>
              <p className="text-sm text-muted">@{profile.handle}</p>
            </div>
          </div>
          {palateMatch != null && (
            <div className="flex items-center gap-2">
              <PalateMatchChip matchPercent={palateMatch} />
              <span className="text-xs text-muted">between your palate and theirs</span>
            </div>
          )}
          {profile.bio && <p className="text-foreground/90">{profile.bio}</p>}
          {profile.homeRegion && <p className="text-sm text-muted">{profile.homeRegion}</p>}
          {signedIn && viewer && (
            <FollowBlockActions
              targetUserId={profile.userId}
              targetHandle={profile.handle}
              initialFollowState={viewerState.followState}
              followsYou={viewerState.followsYou}
            />
          )}
        </div>
      )}

      {!signedIn && (
        <div className="card flex flex-col items-center gap-3 p-6 text-center">
          <p className="text-sm text-muted">Sign in to follow @{profile.handle} and see their palate.</p>
          <Link href="/sign-in" className="btn-primary px-6 py-2.5 text-sm">
            Sign in
          </Link>
        </div>
      )}

      {signedIn && !canSeeContent && (
        <div className="card flex flex-col items-center gap-3 p-8 text-center">
          <Lock size={28} strokeWidth={1.8} className="text-muted" aria-hidden />
          <div>
            <p className="font-display text-lg font-semibold">Private profile</p>
            <p className="mt-1 text-sm text-muted">Request to follow @{profile.handle} to see their palate and notes.</p>
          </div>
        </div>
      )}

      {canSeeContent && (
        <>
          <section className="card flex flex-col items-center gap-3 p-5">
            <h2 className="section-label self-start">Palate</h2>
            {palate.wheelHeat ? (
              <FlavorWheel
                wedgeHeat={palate.wheelHeat.wedges}
                leafHeat={palate.wheelHeat.leaves}
                caption={profile.displayName || `@${profile.handle}`}
                subCaption="palate"
              />
            ) : (
              <EmptyPalate isSelf={viewerState.isSelf} />
            )}
          </section>

          {palate.signatureLeafIds.length > 0 && (
            <section className="flex flex-col gap-2">
              <h2 className="section-label">Signature descriptors</h2>
              <ul className="flex flex-wrap gap-1.5">
                {palate.signatureLeafIds.map((leafId) => {
                  const wedgeId = wedgeForLeaf(leafId);
                  return (
                    <li key={leafId} className="chip flex items-center gap-1.5 px-2.5 py-1 text-xs">
                      <span
                        className="inline-block h-1.5 w-1.5 rounded-full"
                        style={{ backgroundColor: wedgeId ? wedgeColor.get(wedgeId) : "var(--muted)" }}
                        aria-hidden
                      />
                      <span className="text-foreground/90">{leafLabel(leafId) ?? leafId}</span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {(palate.countriesCovered.length > 0 ||
            palate.regionsCovered.length > 0 ||
            palate.stylesCovered.length > 0) && (
            <section className="flex flex-col gap-3">
              {/* Countries first: every bottle has one, so this is the row that
                  is never empty — regions are the finer grain beneath it. */}
              {palate.countriesCovered.length > 0 && (
                <div className="flex flex-col gap-2">
                  <h2 className="section-label">Countries covered</h2>
                  <ul className="flex flex-wrap gap-1.5">
                    {palate.countriesCovered.map((country) => (
                      <li key={country} className="chip px-2.5 py-1 text-xs">
                        {country}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {palate.regionsCovered.length > 0 && (
                <div className="flex flex-col gap-2">
                  <h2 className="section-label">Regions covered</h2>
                  <ul className="flex flex-wrap gap-1.5">
                    {palate.regionsCovered.map((region) => (
                      <li key={region} className="chip px-2.5 py-1 text-xs">
                        {region}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {palate.stylesCovered.length > 0 && (
                <div className="flex flex-col gap-2">
                  <h2 className="section-label">Styles covered</h2>
                  <ul className="flex flex-wrap gap-1.5">
                    {palate.stylesCovered.map((style) => (
                      <li key={style} className="chip px-2.5 py-1 text-xs">
                        {categoryLabel(style)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}

          <section className="flex flex-col gap-3">
            <h2 className="section-label">Recent notes</h2>
            {recentNotes.length === 0 ? (
              <p className="text-sm text-muted">No public notes yet.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {recentNotes.map((note) => (
                  <RecentNoteRow key={note.pourId} note={note} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function EmptyPalate({ isSelf }: { isSelf: boolean }) {
  return (
    <div className="flex flex-col items-center gap-2 py-6 text-center">
      <GlassWater size={28} strokeWidth={1.8} className="text-muted" aria-hidden />
      <p className="font-display text-base font-semibold">No palate yet</p>
      <p className="max-w-xs text-sm text-muted">
        {isSelf ? "Log a pour with a tasting note to start filling in your wheel." : "No tasting notes to show yet."}
      </p>
      {isSelf && (
        <Link href="/pour" className="btn-primary mt-1 px-5 py-2 text-sm">
          Log a pour
        </Link>
      )}
    </div>
  );
}

function RecentNoteRow({ note }: { note: SocialNote }) {
  const topLeaves = Object.entries(note.flavorTags ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([leafId]) => leafId);

  return (
    <li>
      <Link href={`/notes/${note.pourId}`} className="card-flat block p-4 transition-colors hover:border-accent/40">
        <div className="flex items-center justify-between gap-3">
          <span className="truncate font-medium">{note.bottleName}</span>
          {note.rating != null && (
            <span className="flex shrink-0 items-center gap-1 text-sm text-accent">
              <Star size={14} fill="currentColor" aria-hidden /> {note.rating.toFixed(1)}
            </span>
          )}
        </div>
        {topLeaves.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {topLeaves.map((leafId) => {
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
        )}
        <p className="mt-2 text-xs text-muted">
          {note.createdAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
        </p>
      </Link>
    </li>
  );
}
