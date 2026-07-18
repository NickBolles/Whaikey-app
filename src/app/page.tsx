import Link from "next/link";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { getSessionUser } from "@/lib/session";
import { Search, Wine, GlassWater, MessageCircle } from "lucide-react";

export const dynamic = "force-dynamic";

async function SignedOutHero() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[70dvh] px-6 text-center gap-6">
      <div className="text-6xl">🥃</div>
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Whaikey</h1>
        <p className="text-muted mt-2 max-w-sm">
          Track your bottles, log your pours, map your palate — and ask the AI concierge anything
          about whiskey or your own bar.
        </p>
      </div>
      <Link
        href="/sign-in"
        className="rounded-xl bg-accent text-background font-semibold px-8 py-3 hover:bg-accent-deep transition-colors"
      >
        Get started
      </Link>
    </div>
  );
}

export default async function HomePage() {
  const user = await getSessionUser();
  if (!user) return <SignedOutHero />;

  const db = getDb();
  const [owned] = await db
    .select({
      count: sql<number>`count(*)`,
      spent: sql<number>`coalesce(sum(${schema.userBottles.purchasePrice} * ${schema.userBottles.quantity}), 0)`,
    })
    .from(schema.userBottles)
    .where(and(eq(schema.userBottles.userId, user.id), eq(schema.userBottles.relationship, "own")));

  const [pourStats] = await db
    .select({ count: sql<number>`count(*)`, avgRating: sql<number>`avg(${schema.pours.rating})` })
    .from(schema.pours)
    .where(eq(schema.pours.userId, user.id));

  const recentPours = await db
    .select({
      id: schema.pours.id,
      rating: schema.pours.rating,
      createdAt: schema.pours.createdAt,
      bottleName: schema.bottles.name,
      bottleId: schema.bottles.id,
    })
    .from(schema.pours)
    .innerJoin(schema.bottles, eq(schema.pours.bottleId, schema.bottles.id))
    .where(eq(schema.pours.userId, user.id))
    .orderBy(desc(schema.pours.createdAt))
    .limit(5);

  const firstName = user.name?.split(" ")[0] ?? "there";

  return (
    <div className="px-4 pt-8 flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-bold">Welcome back, {firstName}</h1>
        <p className="text-muted text-sm mt-1">What are we pouring tonight?</p>
      </header>

      <section aria-label="Your stats" className="grid grid-cols-3 gap-3">
        <div className="rounded-xl bg-surface border border-border-subtle p-4">
          <div className="text-2xl font-bold text-accent">{owned?.count ?? 0}</div>
          <div className="text-xs text-muted mt-1">bottles owned</div>
        </div>
        <div className="rounded-xl bg-surface border border-border-subtle p-4">
          <div className="text-2xl font-bold text-accent">{pourStats?.count ?? 0}</div>
          <div className="text-xs text-muted mt-1">pours logged</div>
        </div>
        <div className="rounded-xl bg-surface border border-border-subtle p-4">
          <div className="text-2xl font-bold text-accent">
            ${Math.round(owned?.spent ?? 0).toLocaleString()}
          </div>
          <div className="text-xs text-muted mt-1">total spent</div>
        </div>
      </section>

      <section aria-label="Quick actions" className="grid grid-cols-2 gap-3">
        <Link
          href="/pour"
          className="flex items-center gap-3 rounded-xl bg-accent text-background font-semibold p-4 hover:bg-accent-deep transition-colors"
        >
          <GlassWater size={22} aria-hidden /> Log a pour
        </Link>
        <Link
          href="/search"
          className="flex items-center gap-3 rounded-xl bg-surface border border-border-subtle p-4 hover:bg-surface-raised transition-colors"
        >
          <Search size={22} className="text-accent" aria-hidden /> Find a bottle
        </Link>
        <Link
          href="/bar"
          className="flex items-center gap-3 rounded-xl bg-surface border border-border-subtle p-4 hover:bg-surface-raised transition-colors"
        >
          <Wine size={22} className="text-accent" aria-hidden /> My Bar
        </Link>
        <Link
          href="/chat"
          className="flex items-center gap-3 rounded-xl bg-surface border border-border-subtle p-4 hover:bg-surface-raised transition-colors"
        >
          <MessageCircle size={22} className="text-accent" aria-hidden /> Ask the concierge
        </Link>
      </section>

      {recentPours.length > 0 && (
        <section aria-label="Recent pours">
          <h2 className="text-sm font-semibold text-muted uppercase tracking-wide mb-2">
            Recent pours
          </h2>
          <ul className="flex flex-col gap-2">
            {recentPours.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/bottles/${p.bottleId}`}
                  className="flex items-center justify-between rounded-xl bg-surface border border-border-subtle p-3 hover:bg-surface-raised transition-colors"
                >
                  <span className="font-medium">{p.bottleName}</span>
                  {p.rating != null && <span className="text-accent">★ {p.rating.toFixed(1)}</span>}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
