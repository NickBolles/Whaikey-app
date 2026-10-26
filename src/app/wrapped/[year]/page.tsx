import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getDb } from "@/db";
import { getSessionUser } from "@/lib/session";
import { getWrapped, wrappedAvailable } from "@/lib/wrapped";
import { appNow } from "@/lib/clock";
import { ShareCardButton } from "@/components/social/share-card-button";
import { BRAND_NAME } from "@/lib/brand";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Wrapped", robots: { index: false, follow: false } };

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div className="flex flex-col">
      <span className="stat-number text-3xl text-accent">{n}</span>
      <span className="text-xs text-muted">{label}</span>
    </div>
  );
}

/**
 * Whaikey Wrapped (docs/SOCIAL.md §7.14, D19; design board P2): private — only
 * you see this page — breadth-framed, and shareable only as a card you make.
 */
export default async function WrappedPage({ params }: { params: Promise<{ year: string }> }) {
  const user = await getSessionUser();
  const { year: raw } = await params;
  if (!user) redirect(`/sign-in?next=/wrapped/${raw}`);
  const year = Number(raw);
  const now = appNow();
  if (!Number.isInteger(year) || year < 2020 || year > now.getUTCFullYear()) notFound();
  if (!wrappedAvailable(year, now)) {
    return (
      <div className="mx-auto flex min-h-[60dvh] max-w-lg flex-col items-center justify-center gap-3 px-6 text-center">
        <h1 className="font-display text-2xl font-semibold">Your {year} Wrapped opens December 10</h1>
        <p className="text-sm text-muted">The places, distilleries and flavors you discovered this year — never how much.</p>
      </div>
    );
  }
  const w = await getWrapped(getDb(), user.id, year);
  return (
    <div className="mx-auto flex max-w-lg flex-col gap-4 px-3 pb-24 pt-5">
      <header>
        <p className="section-label">{BRAND_NAME} Wrapped · only you can see this</p>
        <h1 className="font-display text-[1.75rem] font-semibold leading-tight">{year}, explored</h1>
      </header>
      {w.empty ? (
        <p className="card-flat p-4 text-sm text-muted">Nothing new on the map for {year} yet.</p>
      ) : (
        <>
          <section className="card grid grid-cols-2 gap-4 p-4">
            <Stat n={w.discovered.countries.length} label="new countries" />
            <Stat n={w.discovered.regions.length} label="new regions" />
            <Stat n={w.discovered.distilleries} label="new distilleries" />
            <Stat n={w.descriptors.length} label="descriptors named" />
          </section>
          {w.bestNewFind && (
            <section className="card-flat p-3">
              <p className="section-label">Best new find</p>
              <Link href={`/bottles/${w.bestNewFind.bottleId}`} className="font-display text-lg font-semibold hover:text-accent">
                {w.bestNewFind.name}
              </Link>
              <span className="ml-2 text-sm text-accent">★ {w.bestNewFind.rating}</span>
            </section>
          )}
          {(w.discovered.regions.length > 0 || w.discovered.countries.length > 0) && (
            <section className="flex flex-col gap-2">
              <p className="section-label">Places you met for the first time</p>
              <ul className="flex flex-wrap gap-1.5">
                {[...w.discovered.regions, ...w.discovered.countries].map((p) => (
                  <li key={p} className="chip px-2.5 py-1 text-xs">
                    {p}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {w.tasteTwin && (
            <p className="text-sm">
              Your taste twin this year:{" "}
              <Link href={`/u/${w.tasteTwin.handle}`} className="text-accent">
                @{w.tasteTwin.handle}
              </Link>{" "}
              <span className="text-muted">({w.tasteTwin.matchPercent}% palate match)</span>
            </p>
          )}
          <ShareCardButton body={{ kind: "wrapped", year }} title={`My ${year} in whiskey`} label="Share my Wrapped card" />
        </>
      )}
    </div>
  );
}
