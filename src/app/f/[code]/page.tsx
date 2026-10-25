import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { getDb } from "@/db";
import { getSessionUser } from "@/lib/session";
import { OFFERED_MARKETS } from "@/lib/age-gate";
import { findTaster, flightByCode, getFlightView } from "@/lib/flights";
import { guestCookieName } from "@/lib/flights/guest-cookie";
import {
  ClaimSeatButton,
  GuestJoinForm,
  HideNoteButton,
  HostControls,
  JoinAsUserButton,
  LinkQr,
  RateGlass,
} from "@/components/social/flight-client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Tasting night", robots: { index: false, follow: false } };

/**
 * A tasting night (docs/SOCIAL.md §7.9, D20; design board C3/C4). One page
 * for every seat at the table: the host (QR, reveal), a taster rating glasses
 * A–F, a signed-out guest (birth-date check, 24 h seat), and after the
 * reveal, everyone's ratings per glass side by side.
 */
export default async function FlightPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const db = getDb();
  const flight = await flightByCode(db, code);
  if (!flight) notFound();
  const user = await getSessionUser();
  const cookieStore = await cookies();
  const guestToken = cookieStore.get(guestCookieName(code))?.value ?? null;
  const taster = await findTaster(db, flight.id, { userId: user?.id ?? null, guestToken });
  const guestSeatToClaim = user && !taster?.userId && guestToken ? await findTaster(db, flight.id, { guestToken }) : null;
  const view = await getFlightView(db, flight, user?.id ?? null, taster);
  const revealed = view.state !== "open";

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-4 px-3 pb-24 pt-5">
      <header className="flex flex-col gap-1">
        <p className="section-label">{view.blind ? "Blind tasting" : "Tasting night"}{view.club ? ` · ${view.club.name}` : ""}</p>
        <h1 className="font-display text-[1.75rem] font-semibold leading-tight">{view.title}</h1>
        <p className="text-xs text-muted">
          Hosted by {view.host ? `@${view.host.handle}` : "a Whaikey member"} · {view.tasters.length} at the table
          {view.scheduledAt && (
            <>
              {" · "}
              <a href={`/api/flights/${code}/ics`} className="text-accent">
                Add to calendar
              </a>
            </>
          )}
        </p>
      </header>

      {view.isHost && (
        <section className="card-flat flex items-center gap-3 p-3">
          {view.state !== "closed" && <LinkQr path={`/f/${code}`} label={`QR code to join ${view.title}`} />}
          <div className="flex flex-col gap-2">
            <p className="text-sm">
              {view.state === "open"
                ? "Guests scan this to join. Nobody sees any rating until you reveal."
                : view.state === "revealed"
                  ? "Revealed. Close the night when the table is done."
                  : "This night is closed."}
            </p>
            <HostControls code={code} title={view.title} state={view.state} />
          </div>
        </section>
      )}

      {guestSeatToClaim && (
        <section className="card-flat flex items-center justify-between gap-3 p-3">
          <p className="text-sm">You rated tonight as a guest on this device.</p>
          <ClaimSeatButton code={code} />
        </section>
      )}

      {!taster && view.state !== "closed" && !guestSeatToClaim && (
        user ? (
          <div className="flex justify-center">
            <JoinAsUserButton code={code} />
          </div>
        ) : (
          <GuestJoinForm code={code} markets={OFFERED_MARKETS} />
        )
      )}

      {taster?.guest && (
        <p className="card-flat p-3 text-xs text-muted">
          You&rsquo;re a guest — your ratings disappear after 24 hours.{" "}
          <Link href={`/sign-in?next=${encodeURIComponent(`/f/${code}`)}`} className="text-accent">
            Create an account to keep them
          </Link>
          .
        </p>
      )}

      <ol className="flex flex-col gap-3">
        {view.slots.map((s) => (
          <li key={s.slot} className="card flex flex-col gap-2 p-3">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="font-display text-lg font-semibold">
                Glass {s.slot}
                {s.bottle && (
                  <>
                    {" · "}
                    <Link href={`/bottles/${s.bottle.id}`} className="text-base font-normal hover:text-accent">
                      {s.bottle.name}
                    </Link>
                  </>
                )}
              </h2>
              {s.results?.average != null && (
                <span className="stat-number text-accent">
                  {s.results.average.toFixed(1)}
                  <span className="text-xs text-muted"> avg</span>
                </span>
              )}
            </div>
            {!revealed && taster && <RateGlass code={code} slot={s.slot} initial={s.mine} />}
            {!revealed && !taster && <p className="text-xs text-muted">{view.blind ? "Hidden until the reveal." : ""}</p>}
            {revealed && s.results && (
              <>
                {s.results.sharedTags.length > 0 && (
                  <p className="text-sm text-foreground/85">The table agreed on {s.results.sharedTags.join(", ")}.</p>
                )}
                <ul className="flex flex-col divide-y divide-border-subtle">
                  {s.results.entries.map((e) => (
                    <li key={e.entryId} className="flex flex-col gap-0.5 py-1.5 text-sm">
                      <span className="flex items-center justify-between gap-2">
                        <span className={e.mine ? "font-medium" : ""}>{e.mine ? "You" : e.name}</span>
                        <span className="flex items-center gap-2">
                          {e.rating != null && <span className="text-accent">★ {e.rating}</span>}
                          {view.isHost && !e.mine && <HideNoteButton code={code} entryId={e.entryId} />}
                        </span>
                      </span>
                      {e.tags.length > 0 && <span className="text-xs text-muted">{e.tags.join(" · ")}</span>}
                      {e.note && <span className="text-xs italic text-muted">&ldquo;{e.note}&rdquo;</span>}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </li>
        ))}
      </ol>

      {revealed && taster && (
        <a href={`/api/flights/${code}/export`} className="self-start text-xs text-muted hover:text-foreground">
          Download results (CSV)
        </a>
      )}
    </div>
  );
}
