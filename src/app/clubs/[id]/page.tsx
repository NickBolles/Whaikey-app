import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getDb } from "@/db";
import { getSessionUser } from "@/lib/session";
import { getClubView } from "@/lib/clubs";
import { UserAvatar } from "@/components/user-avatar";
import { ClubInvite, MemberRemove } from "@/components/social/club-actions";
import { ClubChallengeForm } from "@/components/social/challenge-client";

export const dynamic = "force-dynamic";

/**
 * A club's home (§7.8): who's in it, its tasting nights, the club shelf
 * ("tasted by the club" — distinct bottles) and the club passport (distinct
 * countries and regions). Members only; anyone else gets a 404, so a club's
 * existence is not disclosed to people outside it.
 */
export default async function ClubPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  const { id } = await params;
  if (!user) redirect(`/sign-in?next=/clubs/${id}`);
  const club = await getClubView(getDb(), user.id, id);
  if (!club) notFound();
  const admin = club.viewerRole !== "member";
  return (
    <div className="mx-auto flex max-w-lg flex-col gap-4 px-3 pb-24 pt-5">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-[1.75rem] font-semibold leading-tight">{club.name}</h1>
        {club.description && <p className="text-sm text-muted">{club.description}</p>}
        <p className="text-xs text-muted">
          {club.members.length} {club.members.length === 1 ? "member" : "members"} · {club.passport.countries} countries ·{" "}
          {club.passport.regions} regions tasted together
        </p>
      </header>

      {admin && (
        <section className="card-flat p-3">
          <ClubInvite clubId={club.id} clubName={club.name} />
          <div className="mt-3 border-t border-border-subtle pt-3">
            <ClubChallengeForm clubId={club.id} />
          </div>
        </section>
      )}

      <section aria-labelledby="club-nights" className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <h2 id="club-nights" className="section-label">
            Tasting nights
          </h2>
          <Link href={`/flights/new?club=${club.id}`} className="text-xs font-medium text-accent">
            Host one →
          </Link>
        </div>
        {club.flights.length === 0 ? (
          <p className="text-sm text-muted">None yet. A blind flight is the best first night.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border-subtle rounded-xl border border-border-subtle">
            {club.flights.map((f) => (
              <li key={f.id}>
                <Link href={`/f/${f.joinCode}`} className="flex items-center justify-between px-3 py-2.5 text-sm hover:bg-surface-raised">
                  <span className="truncate">{f.title}</span>
                  <span className="text-xs text-muted">{f.state === "open" ? "Tasting" : f.state === "revealed" ? "Revealed" : "Closed"}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="club-shelf" className="flex flex-col gap-2">
        <h2 id="club-shelf" className="section-label">
          Tasted by the club
        </h2>
        {club.shelf.length === 0 ? (
          <p className="text-sm text-muted">Bottles from your tasting nights and members&rsquo; shared notes collect here.</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {club.shelf.slice(0, 40).map((b) => (
              <li key={b.id}>
                <Link href={`/bottles/${b.id}`} className="chip block px-2.5 py-1 text-xs hover:text-accent">
                  {b.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="club-members" className="flex flex-col gap-2">
        <h2 id="club-members" className="section-label">
          Members
        </h2>
        <ul className="flex flex-col divide-y divide-border-subtle rounded-xl border border-border-subtle">
          {club.members.map((m) => (
            <li key={m.userId} className="flex items-center gap-3 px-3 py-2">
              <UserAvatar name={m.displayName || m.handle} image={m.avatarUrl} size={28} />
              <Link href={`/u/${m.handle}`} className="min-w-0 flex-1 truncate text-sm">
                {m.displayName || `@${m.handle}`} <span className="text-xs text-muted">@{m.handle}</span>
              </Link>
              {m.role !== "member" && <span className="text-xs text-muted">{m.role}</span>}
              {m.userId === user.id ? (
                <MemberRemove clubId={club.id} userId={m.userId} label="you" self />
              ) : (
                admin && m.role !== "owner" && (club.viewerRole === "owner" || m.role === "member") && (
                  <MemberRemove clubId={club.id} userId={m.userId} label={`@${m.handle}`} self={false} />
                )
              )}
            </li>
          ))}
        </ul>
      </section>

      <a href={`/api/clubs/${club.id}/export`} className="self-start text-xs text-muted hover:text-foreground">
        Export club data (CSV)
      </a>
    </div>
  );
}
