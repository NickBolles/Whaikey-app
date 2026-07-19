import Link from "next/link";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { getSessionUser } from "@/lib/session";
import { getUserPalate } from "@/lib/palate-store";
import { PalateWheel } from "@/components/palate-wheel";
import { RecommendationRail } from "@/components/recommendation-rail";
import {
  Search,
  ScanLine,
  Wine,
  GlassWater,
  GraduationCap,
  MessageCircle,
  ChevronRight,
  Star,
} from "lucide-react";

export const dynamic = "force-dynamic";

function Wordmark() {
  return (
    <div className="flex items-center gap-2 text-muted">
      <span aria-hidden className="text-base leading-none">🥃</span>
      <span className="font-display text-sm tracking-wide">Whaikey</span>
    </div>
  );
}

function SignedOutHero() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[78dvh] px-6 text-center gap-7">
      <div aria-hidden className="text-6xl drop-shadow-[0_0_24px_rgba(232,161,60,0.25)]">🥃</div>
      <div>
        <h1 className="font-display text-5xl font-semibold tracking-tight text-gradient-amber">
          Whaikey
        </h1>
        <p className="text-muted mt-4 max-w-sm leading-relaxed">
          Track your bottles, log your pours, map your palate — and ask the AI concierge anything
          about whiskey or your own bar.
        </p>
      </div>
      <Link href="/sign-in" className="btn-primary px-10 py-3.5 text-base">
        Get started
      </Link>
      <p className="text-xs text-muted/70">Your notes stay yours. Sip responsibly.</p>
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
    .select({ count: sql<number>`count(*)` })
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

  const palate = await getUserPalate(db, user.id);

  const firstName = user.name?.split(" ")[0] ?? "there";
  const stats = [
    { value: String(owned?.count ?? 0), label: "bottles owned" },
    { value: String(pourStats?.count ?? 0), label: "pours logged" },
    { value: `$${Math.round(owned?.spent ?? 0).toLocaleString()}`, label: "total spent" },
  ];

  return (
    <div className="px-4 pt-5 flex flex-col gap-7">
      <Wordmark />

      <header>
        <h1 className="font-display text-[2rem] leading-tight font-semibold">
          Welcome back, {firstName}
        </h1>
        <p className="text-muted mt-1">What are we pouring tonight?</p>
      </header>

      <section aria-label="Your stats" className="grid grid-cols-3 gap-3">
        {stats.map((s) => (
          <div key={s.label} className="card p-4">
            <div className="stat-number text-[1.7rem] leading-none text-accent">{s.value}</div>
            <div className="text-[11px] text-muted mt-2">{s.label}</div>
          </div>
        ))}
      </section>

      <section aria-label="Quick actions" className="flex flex-col gap-3">
        <Link href="/pour" className="btn-primary flex items-center justify-center gap-3 p-4 text-base">
          <GlassWater size={20} aria-hidden /> Log a pour
        </Link>
        <div className="grid grid-cols-2 gap-3">
          {[
            { href: "/search", label: "Find a bottle", icon: Search },
            { href: "/scan", label: "Scan bottles", icon: ScanLine },
            { href: "/bar", label: "My Bar", icon: Wine },
            { href: "/chat", label: "Concierge", icon: MessageCircle },
          ].map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className="card flex flex-col items-center gap-2 p-4 text-center text-[13px] hover:brightness-110 transition-[filter]"
            >
              <Icon size={20} className="text-accent" aria-hidden />
              {label}
            </Link>
          ))}
        </div>
      </section>

      <RecommendationRail mode="tonight" title="What to pour tonight" />

      <RecommendationRail mode="discovery" title="For your palate" />

      <PalateWheel vector={palate.vector} sampleSize={palate.sampleSize} />

      <section aria-label="Whiskey School">
        <h2 className="section-label mb-3">Whiskey School</h2>
        <Link
          href="/learn"
          className="card flex items-center gap-4 p-5 hover:brightness-110 transition-[filter]"
        >
          <GraduationCap size={22} strokeWidth={1.8} className="text-accent shrink-0" aria-hidden />
          <span className="flex-1 min-w-0">
            <span className="font-display text-lg font-semibold block">Learn as you sip</span>
            <span className="text-sm text-muted block mt-0.5">
              Short lessons on styles, casks, and the flavor wheel.
            </span>
          </span>
          <ChevronRight size={18} strokeWidth={1.8} className="text-muted shrink-0" aria-hidden />
        </Link>
      </section>

      {recentPours.length > 0 && (
        <section aria-label="Recent pours">
          <h2 className="section-label mb-3">Recent pours</h2>
          <ul className="flex flex-col gap-2.5">
            {recentPours.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/bottles/${p.bottleId}`}
                  className="card-flat flex items-center justify-between p-4 hover:bg-surface-raised transition-colors"
                >
                  <span className="font-medium">{p.bottleName}</span>
                  {p.rating != null && (
                    <span className="flex items-center gap-1.5 text-accent">
                      <Star size={14} fill="currentColor" aria-hidden />
                      <span className="stat-number text-lg leading-none">{p.rating.toFixed(1)}</span>
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
