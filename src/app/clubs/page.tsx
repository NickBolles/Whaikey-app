import Link from "next/link";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { getSessionUser } from "@/lib/session";
import { listMyClubs } from "@/lib/clubs";
import { listMyFlights } from "@/lib/flights";
import { unreadCount } from "@/lib/notify";
import { SocialTabs } from "@/components/social/social-tabs";
import { CreateClubForm } from "@/components/social/club-actions";

export const dynamic = "force-dynamic";

const STATE_LABEL = { open: "Tasting", revealed: "Revealed", closed: "Closed" } as const;

/**
 * Clubs and tasting nights (docs/SOCIAL.md §7.8–7.9; design board C5):
 * invite-only, so this page lists only what you are already part of — there
 * is no directory to browse.
 */
export default async function ClubsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in?next=/clubs");
  const db = getDb();
  const [clubs, flights, unread] = await Promise.all([listMyClubs(db, user.id), listMyFlights(db, user.id), unreadCount(db, user.id)]);
  return (
    <div className="mx-auto flex max-w-lg flex-col gap-4 px-3 pb-24 pt-5">
      <header className="flex flex-col gap-3">
        <h1 className="font-display text-[1.75rem] font-semibold leading-tight">Friends</h1>
        <SocialTabs unread={unread} />
      </header>

      <section aria-labelledby="clubs-heading" className="flex flex-col gap-2">
        <h2 id="clubs-heading" className="section-label">
          Your clubs
        </h2>
        {clubs.length === 0 ? (
          <p className="text-sm text-muted">
            A club is the people you taste with — a shared shelf, a passport you fill together, and tasting nights. Invite-only.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border-subtle rounded-xl border border-border-subtle">
            {clubs.map((c) => (
              <li key={c.id}>
                <Link href={`/clubs/${c.id}`} className="flex items-center justify-between gap-3 px-3 py-2.5 hover:bg-surface-raised">
                  <span className="min-w-0 truncate text-sm font-medium">{c.name}</span>
                  <span className="shrink-0 text-xs text-muted">
                    {c.memberCount} {c.memberCount === 1 ? "member" : "members"}
                    {c.role !== "member" ? ` · ${c.role}` : ""}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <div className="card-flat p-3">
          <CreateClubForm />
        </div>
      </section>

      <section aria-labelledby="nights-heading" className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <h2 id="nights-heading" className="section-label">
            Tasting nights
          </h2>
          <Link href="/flights/new" className="text-xs font-medium text-accent">
            Host one →
          </Link>
        </div>
        {flights.length === 0 ? (
          <p className="text-sm text-muted">
            Pour 3–6 bottles behind letters, everyone rates on their phone, then you reveal them all together. Guests
            join with a QR code — no account needed for the night.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border-subtle rounded-xl border border-border-subtle">
            {flights.map((f) => (
              <li key={f.joinCode}>
                <Link href={`/f/${f.joinCode}`} className="flex items-center justify-between gap-3 px-3 py-2.5 hover:bg-surface-raised">
                  <span className="min-w-0 truncate text-sm">{f.title}</span>
                  <span className="shrink-0 text-xs text-muted">{STATE_LABEL[f.state]}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
