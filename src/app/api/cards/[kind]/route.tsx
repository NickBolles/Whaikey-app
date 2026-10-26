import { ImageResponse } from "next/og";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { CARD_FORMATS, CARD_KINDS, cardEpoch, cardOwner, verifyCard, type CardFormat, type CardKind } from "@/lib/cards";
import { getPalateCard } from "@/lib/social";
import { leafLabel } from "@/lib/flavor-wheel";
import { getWrapped, wrappedAvailable } from "@/lib/wrapped";
import { findTaster, flightVisibleTo, getFlightView } from "@/lib/flights";
import { findOutingSeat, formatVisitDay, getOutingView, outingVisibleTo } from "@/lib/outings";
import { BRAND_NAME } from "@/lib/brand";

const BRAND_UPPER = BRAND_NAME.toUpperCase();

export const runtime = "nodejs";

const BG = { background: "#0d1410", color: "#eee7d6", backgroundImage: "radial-gradient(circle at 80% 10%, #1c3226, #0d1410 55%)" };
const ACCENT = "#d27b3e";
const MUTED = "#93a092";

interface Stat {
  value: string;
  label: string;
}

/** One layout for every card: eyebrow, headline, up to four stats, a chip line, footer. No prices, no volumes, ever. */
function Card({ format, eyebrow, title, stats, chips, footer }: { format: CardFormat; eyebrow: string; title: string; stats: Stat[]; chips: string[]; footer: string }) {
  const story = format === "story";
  const pad = story ? 96 : 64;
  return (
    <div style={{ height: "100%", width: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: pad, ...BG }}>
      <div style={{ display: "flex", fontSize: story ? 34 : 24, letterSpacing: 5, color: ACCENT }}>{eyebrow}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: story ? 56 : 28 }}>
        <div style={{ display: "flex", fontSize: story ? 96 : 60, fontWeight: 700, lineHeight: 1.05 }}>{title}</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: story ? 48 : 40 }}>
          {stats.map((s) => (
            <div key={s.label} style={{ display: "flex", flexDirection: "column", minWidth: story ? 380 : 220 }}>
              <div style={{ display: "flex", fontSize: story ? 120 : 64, fontWeight: 700, color: ACCENT, lineHeight: 1 }}>{s.value}</div>
              <div style={{ display: "flex", fontSize: story ? 36 : 24, color: "#d3cdbb" }}>{s.label}</div>
            </div>
          ))}
        </div>
        {chips.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14, fontSize: story ? 34 : 22, color: "#d3cdbb" }}>
            {chips.slice(0, story ? 10 : 6).map((c) => (
              <div key={c} style={{ display: "flex", border: `2px solid ${MUTED}`, borderRadius: 999, padding: story ? "10px 26px" : "6px 18px" }}>
                {c}
              </div>
            ))}
          </div>
        )}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: story ? 32 : 22, color: MUTED }}>
        <span>{footer}</span>
        <span>whiskey, remembered</span>
      </div>
    </div>
  );
}

/**
 * GET /api/cards/[kind]?s=&x=&f=story|link&sig= — a share card PNG. 404 for a
 * bad signature, an unknown subject, or one that is no longer shareable
 * (a closed account, an unrevealed flight, a Wrapped that hasn't opened).
 */
export async function GET(req: Request, ctx: { params: Promise<{ kind: string }> }) {
  const { kind } = await ctx.params;
  const url = new URL(req.url);
  const subject = url.searchParams.get("s") ?? "";
  const extra = url.searchParams.get("x") ?? "";
  const format = (url.searchParams.get("f") ?? "link") as CardFormat;
  const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!(CARD_KINDS as readonly string[]).includes(kind) || !(format in CARD_FORMATS)) return notFound();
  const db = getDb();
  const owner = cardOwner(kind as CardKind, subject, extra);
  if (!owner || !verifyCard(kind as CardKind, subject, extra, url.searchParams.get("sig"), await cardEpoch(db, owner))) return notFound();
  // Every card stops rendering while its owner is suspended or stepped back.
  const ownerProfile = await db.query.userProfiles.findFirst({ where: eq(schema.userProfiles.userId, owner) });
  if (!ownerProfile || !ownerProfile.socialEnabled || ownerProfile.suspendedAt) return notFound();

  let card: Parameters<typeof Card>[0] | null = null;

  if (kind === "palate" || kind === "passport" || kind === "wrapped") {
    const profile = await db.query.userProfiles.findFirst({ where: eq(schema.userProfiles.userId, subject) });
    if (!profile || !profile.socialEnabled || profile.suspendedAt) return notFound();
    const name = profile.displayName || `@${profile.handle}`;
    if (kind === "palate" || kind === "passport") {
      const p = await getPalateCard(db, subject);
      card = {
        format,
        eyebrow: kind === "palate" ? `${BRAND_UPPER} · PALATE` : `${BRAND_UPPER} · PASSPORT`,
        title: kind === "palate" ? `${name}'s palate` : `${name}'s whiskey passport`,
        stats:
          kind === "passport"
            ? [
                { value: String(p.countriesCovered.length), label: "countries" },
                { value: String(p.regionsCovered.length), label: "regions" },
                { value: String(p.stylesCovered.length), label: "styles" },
              ]
            : [],
        chips: kind === "palate" ? p.signatureLeafIds.map((id) => leafLabel(id) ?? id) : [...p.regionsCovered, ...p.countriesCovered],
        footer: `@${profile.handle}`,
      };
    } else {
      const year = Number(extra);
      if (!Number.isInteger(year) || !wrappedAvailable(year, new Date())) return notFound();
      const w = await getWrapped(db, subject, year);
      card = {
        format,
        eyebrow: `${BRAND_UPPER} WRAPPED · ${year}`,
        title: w.bestNewFind ? `Best new find: ${w.bestNewFind.name}` : `${name}'s ${year}, explored`,
        stats: [
          { value: String(w.discovered.countries.length), label: "new countries" },
          { value: String(w.discovered.regions.length), label: "new regions" },
          { value: String(w.discovered.distilleries), label: "new distilleries" },
          { value: String(w.descriptors.length), label: "descriptors named" },
        ],
        chips: [...w.discovered.regions, ...w.discovered.countries],
        footer: w.tasteTwin ? `Taste twin: @${w.tasteTwin.handle}` : `@${profile.handle}`,
      };
    }
  } else if (kind === "flight") {
    // Rendered as the taster who minted it (their seat, their blocks), and only
    // while they still hold that seat and can still see the flight.
    const byId = await db.query.flights.findFirst({ where: eq(schema.flights.id, subject) });
    const flight = byId && (await flightVisibleTo(db, byId, extra || null)) ? byId : null;
    if (!flight || flight.state === "open" || !extra) return notFound();
    const seat = await findTaster(db, flight.id, { userId: extra });
    if (!seat) return notFound();
    const view = await getFlightView(db, flight, extra, seat);
    card = {
      format,
      eyebrow: view.blind ? `${BRAND_UPPER} · BLIND TASTING RESULTS` : `${BRAND_UPPER} · TASTING NIGHT`,
      title: view.title,
      stats: view.slots
        .filter((s) => s.results?.average != null)
        .slice(0, 4)
        .map((s) => ({ value: `${s.slot} · ${s.results!.average!.toFixed(1)}★`, label: s.bottle?.name ?? "" })),
      chips: view.slots.flatMap((s) => s.results?.sharedTags ?? []).slice(0, 8),
      footer: `${view.tasters.length} at the table`,
    };
  } else if (kind === "outing") {
    // The outing recap, rendered as the person who shared it and only while
    // they are still on it. Breadth and consensus only — no amounts, no
    // per-person tallies (§3.1).
    const byId = await db.query.outings.findFirst({ where: eq(schema.outings.id, subject) });
    const outing = byId && extra && (await outingVisibleTo(db, byId, extra)) ? byId : null;
    if (!outing || outing.state !== "ended") return notFound();
    const seat = await findOutingSeat(db, outing.id, { userId: extra });
    if (!seat) return notFound();
    const view = await getOutingView(db, outing, extra, seat);
    const recap = view.recap!;
    card = {
      format,
      eyebrow: `${BRAND_UPPER} · OUTING · ${formatVisitDay(view.visitOn).toUpperCase()}`,
      title: view.title,
      stats: [
        { value: String(recap.bottles.length), label: recap.bottles.length === 1 ? "bottle explored together" : "bottles explored together" },
        ...(recap.favorite ? [{ value: recap.favorite.average != null ? `${recap.favorite.average.toFixed(1)}★` : "★", label: `${recap.favorite.consensus ? "Group favorite" : "Top rated"}: ${recap.favorite.label}` }] : []),
      ],
      chips: [...recap.spread.map((s) => `${s.label} ${s.share}%`), ...recap.topTags].slice(0, 10),
      footer: view.distilleryName,
    };
  }
  if (!card) return notFound();
  return new ImageResponse(<Card {...card} />, { ...CARD_FORMATS[format], headers: { "cache-control": "private, no-store", "x-robots-tag": "noindex, noimageindex" } });
}
