import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { getSessionUser } from "@/lib/session";
import { OFFERED_MARKETS } from "@/lib/age-gate";
import { canViewBottle } from "@/lib/catalog-visibility";
import { findOutingSeat, formatVisitDay, getOutingView, outingGuestCookieName, visibleOutingByCode } from "@/lib/outings";
import { GuestJoinForm, LinkQr } from "@/components/social/flight-client";
import { ShareCardButton } from "@/components/social/share-card-button";
import {
  ClaimOutingSeatButton,
  FeedItemAction,
  JoinOutingButton,
  OutingHostControls,
  OutingNoteComposer,
  OutingWatcher,
  QuickAddTasting,
  RideReminder,
} from "@/components/social/outing-client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Outing", robots: { index: false, follow: false } };

/**
 * An outing — a group distillery visit (docs/SOCIAL.md §7.15, D22). One page
 * for everyone on the trip: the host (QR, invites, end), a friend or a 24 h
 * guest logging what they tasted, the shared feed, and once the host ends it,
 * the recap. Built for a phone in one hand at a tasting bar.
 */
export default async function OutingPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<{ added?: string | string[] }>;
}) {
  const { code } = await params;
  const { added } = await searchParams;
  const db = getDb();
  const user = await getSessionUser();
  const outing = await visibleOutingByCode(db, code, user?.id ?? null);
  if (!outing) notFound();
  const cookieStore = await cookies();
  const guestToken = cookieStore.get(outingGuestCookieName(code))?.value ?? null;
  const seat = await findOutingSeat(db, outing.id, { userId: user?.id ?? null, guestToken });
  const guestSeatToClaim = user && guestToken ? await findOutingSeat(db, outing.id, { guestToken }) : null;
  const view = await getOutingView(db, outing, user?.id ?? null, seat);
  const open = view.state === "open";
  const onTrip = !!seat || view.isHost;

  // Back from the add-a-bottle flow with the new bottle picked.
  const addedId = Array.isArray(added) ? added[0] : added;
  let initialBottle: { id: string; name: string } | null = null;
  if (addedId && seat && user) {
    const b = await db.query.bottles.findFirst({ where: eq(schema.bottles.id, addedId) });
    if (b && canViewBottle(b, user.id)) initialBottle = { id: b.id, name: b.name };
  }

  const recap = view.recap;
  return (
    <div className="mx-auto flex max-w-lg flex-col gap-4 px-3 pb-24 pt-5">
      {onTrip && open && <OutingWatcher code={code} stamp={view.stamp} />}
      <header className="flex flex-col gap-1">
        <p className="section-label">
          Outing{view.club ? ` · ${view.club.name}` : ""}
          {!open ? " · Ended" : ""}
        </p>
        <h1 className="font-display text-[1.75rem] font-semibold leading-tight">{view.title}</h1>
        <p className="text-sm text-foreground/85">
          {view.distilleryName}
          {view.location ? ` · ${view.location}` : ""} · {formatVisitDay(view.visitOn)}
        </p>
        <p className="text-xs text-muted">
          Hosted by {view.host ? `@${view.host.handle}` : "a Whaikey member"}
          {onTrip && view.people.length > 0 && <> · {view.people.map((p) => p.name).join(", ")}</>}
        </p>
      </header>

      {view.isHost && (
        <section aria-label="Host controls" className="card-flat flex flex-col gap-3 p-3">
          <div className="flex items-center gap-3">
            {open && <LinkQr path={`/o/${code}`} label={`QR code to join ${view.title}`} />}
            <p className="text-sm">
              {open
                ? "Friends scan this to join — no account needed for the day. End the outing when you're done to share the recap."
                : "This outing has ended. The recap below is everyone's."}
            </p>
          </div>
          <OutingHostControls code={code} title={view.title} state={view.state} />
        </section>
      )}

      {onTrip && open && view.rideReminder && <RideReminder code={code} />}

      {guestSeatToClaim && (
        <section className="card-flat flex items-center justify-between gap-3 p-3">
          <p className="text-sm">You logged this outing as a guest on this device.</p>
          <ClaimOutingSeatButton code={code} />
        </section>
      )}

      {!seat && !view.isHost && open && !guestSeatToClaim &&
        (user ? (
          <div className="flex justify-center">
            <JoinOutingButton code={code} />
          </div>
        ) : (
          <GuestJoinForm
            code={code}
            markets={OFFERED_MARKETS}
            endpoint="/api/outings/join"
            intro="Join as a guest — no account needed for the day. What you log is kept for 24 hours unless you create one."
            submitLabel="Join the outing"
            closedCopy="This outing has ended or the link is wrong."
          />
        ))}

      {!seat && !view.isHost && !open && <p className="card-flat p-3 text-sm text-muted">This outing has ended.</p>}

      {seat?.guest && (
        <p className="card-flat p-3 text-xs text-muted">
          You&rsquo;re a guest — what you log disappears after 24 hours.{" "}
          <Link href={`/sign-in?next=${encodeURIComponent(`/o/${code}`)}`} className="text-accent">
            Create an account to keep it
          </Link>
          .
        </p>
      )}

      {!open && recap && onTrip && (
        <section aria-labelledby="recap-heading" className="card flex flex-col gap-3 p-4">
          <h2 id="recap-heading" className="font-display text-xl font-semibold">
            The recap
          </h2>
          {recap.bottles.length === 0 ? (
            <p className="text-sm text-muted">Nothing was logged on this outing.</p>
          ) : (
            <>
              {recap.favorite && (
                <div className="flex flex-col gap-0.5">
                  <p className="section-label">{recap.favorite.consensus ? "Group favorite" : "Top rated"}</p>
                  <p className="font-display text-lg font-semibold leading-tight">
                    {recap.favorite.bottleId ? (
                      <Link href={`/bottles/${recap.favorite.bottleId}`} className="hover:text-accent">
                        {recap.favorite.label}
                      </Link>
                    ) : (
                      recap.favorite.label
                    )}
                    {recap.favorite.average != null && <span className="ml-2 text-base text-accent">★ {recap.favorite.average.toFixed(1)}</span>}
                  </p>
                  {recap.favorite.sharedTags.length > 0 && <p className="text-xs text-muted">You agreed on {recap.favorite.sharedTags.join(", ")}.</p>}
                </div>
              )}
              {recap.spread.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <p className="section-label">Flavor spread</p>
                  <div className="flex h-3 overflow-hidden rounded-full" role="img" aria-label={recap.spread.map((s) => `${s.label} ${s.share}%`).join(", ")}>
                    {recap.spread.map((s) => (
                      <span key={s.id} style={{ width: `${s.share}%`, background: s.color }} />
                    ))}
                  </div>
                  <p className="text-xs text-muted">{recap.spread.map((s) => `${s.label} ${s.share}%`).join(" · ")}</p>
                </div>
              )}
              <div className="flex flex-col gap-1">
                <p className="section-label">What you explored together</p>
                <ul className="flex flex-col divide-y divide-border-subtle">
                  {recap.bottles.map((b) => (
                    <li key={`${b.bottleId ?? ""}${b.label}`} className="flex items-baseline justify-between gap-2 py-1.5 text-sm">
                      <span className="min-w-0">
                        {b.bottleId ? (
                          <Link href={`/bottles/${b.bottleId}`} className="hover:text-accent">
                            {b.label}
                          </Link>
                        ) : (
                          b.label
                        )}
                        {b.sharedTags.length > 0 && <span className="block text-xs text-muted">{b.sharedTags.join(" · ")}</span>}
                      </span>
                      {b.average != null && <span className="shrink-0 text-accent">★ {b.average.toFixed(1)}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
          <div className="flex flex-wrap items-center gap-3">
            {seat && !seat.guest && recap.bottles.length > 0 && (
              <ShareCardButton body={{ kind: "outing", code }} title={`${view.title} — recap`} label="Share the recap card" />
            )}
            <a href={`/api/outings/${code}/export`} className="tap-target text-xs text-muted hover:text-foreground">
              Download (CSV)
            </a>
          </div>
        </section>
      )}

      {seat && open && <QuickAddTasting code={code} signedIn={!!user && !seat.guest} initialBottle={initialBottle} />}

      {onTrip && (
        <section aria-labelledby="feed-heading" className="flex flex-col gap-2">
          <h2 id="feed-heading" className="section-label">
            The group&rsquo;s feed
          </h2>
          {seat && open && <OutingNoteComposer code={code} />}
          {view.feed.length === 0 ? (
            <p className="text-sm text-muted">Nothing yet — what the group tastes shows up here.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {view.feed.map((f) => (
                <li key={`${f.kind}-${f.id}`} className="card-flat flex flex-col gap-1 p-3 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <p className="min-w-0">
                      <span className={f.mine ? "font-medium" : ""}>{f.mine ? "You" : f.who}</span>
                      {f.kind === "tasting" && (
                        <>
                          {" tasted "}
                          {f.bottleId ? (
                            <Link href={`/bottles/${f.bottleId}`} className="font-medium hover:text-accent">
                              {f.label}
                            </Link>
                          ) : (
                            <span className="font-medium">{f.label}</span>
                          )}
                        </>
                      )}
                    </p>
                    <span className="flex shrink-0 items-center gap-1">
                      {f.kind === "tasting" && f.rating != null && <span className="text-accent">★ {f.rating}</span>}
                      {f.mine && <FeedItemAction code={code} kind={f.kind} id={f.id} mode="delete" />}
                      {!f.mine && view.isHost && <FeedItemAction code={code} kind={f.kind} id={f.id} mode="hide" />}
                    </span>
                  </div>
                  {f.kind === "tasting" && f.tags && f.tags.length > 0 && <p className="text-xs text-muted">{f.tags.join(" · ")}</p>}
                  {f.text && <p className={f.kind === "tasting" ? "text-xs italic text-muted" : "text-foreground/90"}>{f.kind === "tasting" ? <>&ldquo;{f.text}&rdquo;</> : f.text}</p>}
                  {f.kind === "tasting" && f.mine && f.bottleId && seat && !seat.guest && (
                    <Link href={`/pour?bottleId=${encodeURIComponent(f.bottleId)}`} className="tap-target self-start text-xs text-accent">
                      Add to my journal →
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
