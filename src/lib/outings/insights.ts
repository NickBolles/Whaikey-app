import { leafLabel } from "@/lib/flavor-wheel";

/**
 * Outing insights (owner request 2026-10-29): who tastes alike, whose notes
 * the group picked up, the favourite and the most divisive bottle, and a few
 * understated recognitions for the recap. Everything here is about ratings,
 * descriptors and notes. It never sees pours, amounts or how many glasses
 * anyone had, and nothing ranks people by quantity (docs/RESPONSIBLE).
 *
 * All functions are pure; `getOutingView` feeds them the visible tastings.
 */

/** One person's latest verdict on one bottle of the outing. */
export interface InsightTasting {
  participantId: string;
  /** Board key of the bottle (`b:<id>` / `l:<label>`). */
  key: string;
  label: string;
  rating: number | null;
  /** Flavor-wheel leaf ids. */
  tags: string[];
  note: string | null;
  at: number;
}

export interface InsightPerson {
  participantId: string;
  name: string;
}

/** The minimum before any palate comparison is shown. */
export const MIN_SHARED_BOTTLES = 2;
/** Rating spread (stars, max minus min) before a bottle counts as divisive. */
export const DIVISIVE_SPREAD = 1.5;

export interface PairSimilarity {
  a: string;
  b: string;
  /** 0..1 */
  score: number;
  shared: number;
  /** Mean absolute rating difference in stars. */
  meanGap: number;
  commonTags: string[];
}

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

/** Pearson correlation, or null when either side has no variance. */
export function pearson(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 2) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

export function jaccard(a: string[], b: string[]): number | null {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return null;
  let both = 0;
  for (const x of A) if (B.has(x)) both++;
  return both / (A.size + B.size - both);
}

/**
 * How alike two palates are on the bottles both rated: rating agreement
 * (correlation once there are 3+ bottles with spread, otherwise closeness on a
 * 5-star scale) weighted 60/40 with descriptor overlap when either named any.
 * Null below MIN_SHARED_BOTTLES.
 */
export function pairSimilarity(a: InsightTasting[], b: InsightTasting[]): Omit<PairSimilarity, "a" | "b"> | null {
  const bByKey = new Map(b.filter((t) => t.rating != null).map((t) => [t.key, t]));
  const pairs = a.filter((t) => t.rating != null && bByKey.has(t.key)).map((t) => [t, bByKey.get(t.key)!] as const);
  if (pairs.length < MIN_SHARED_BOTTLES) return null;
  const ra = pairs.map(([x]) => x.rating!);
  const rb = pairs.map(([, y]) => y.rating!);
  const meanGap = mean(ra.map((x, i) => Math.abs(x - rb[i])));
  const closeness = Math.max(0, 1 - meanGap / 4);
  const r = pairs.length >= 3 ? pearson(ra, rb) : null;
  const ratingSim = r == null ? closeness : 0.5 * ((r + 1) / 2) + 0.5 * closeness;
  const tagScores = pairs.map(([x, y]) => jaccard(x.tags, y.tags)).filter((s): s is number => s != null);
  const tagSim = tagScores.length ? mean(tagScores) : null;
  const score = tagSim == null ? ratingSim : 0.6 * ratingSim + 0.4 * tagSim;
  const common = new Map<string, number>();
  for (const [x, y] of pairs) for (const t of x.tags) if (y.tags.includes(t)) common.set(t, (common.get(t) ?? 0) + 1);
  const commonTags = [...common.entries()]
    .sort((p, q) => q[1] - p[1] || p[0].localeCompare(q[0]))
    .slice(0, 3)
    .map(([t]) => t);
  return { score, shared: pairs.length, meanGap, commonTags };
}

export interface OutingInsights {
  /** Plain reason when there isn't enough yet; null once something is shown. */
  waiting: string | null;
  twins: (PairSimilarity & { aName: string; bName: string; why: string }) | null;
  closest: (PairSimilarity & { name: string; why: string }) | null;
  learnFrom: { participantId: string; name: string; why: string } | null;
  favourite: { key: string; label: string; average: number; raters: number } | null;
  divisive: { key: string; label: string; low: number; high: number; why: string } | null;
  agreed: Array<{ key: string; label: string; tags: string[] }>;
  calledIt: { participantId: string; name: string; label: string; why: string } | null;
}

const tagLabel = (id: string) => (leafLabel(id) ?? id).toLowerCase();
const list = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const stars = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

function gapPhrase(gap: number) {
  if (gap < 0.25) return "gave the same stars";
  return `were within ${stars(Math.round(gap * 10) / 10)} ${gap <= 1 ? "star" : "stars"} of each other on average`;
}

function pairWhy(p: Omit<PairSimilarity, "a" | "b">) {
  const base = `Across ${p.shared} bottles you both rated, you ${gapPhrase(p.meanGap)}`;
  return p.commonTags.length ? `${base}, and both picked out ${list(p.commonTags.map(tagLabel))}.` : `${base}.`;
}

/** Tags named first by someone on a bottle that at least one other person later named too. */
function picksAdopted(tastings: InsightTasting[]) {
  const byKey = new Map<string, InsightTasting[]>();
  for (const t of tastings) byKey.set(t.key, [...(byKey.get(t.key) ?? []), t]);
  const credit = new Map<string, Array<{ tag: string; label: string; followers: number }>>();
  for (const [, ts] of byKey) {
    const sorted = [...ts].sort((x, y) => x.at - y.at);
    const firstBy = new Map<string, InsightTasting>();
    for (const t of sorted) for (const tag of t.tags) if (!firstBy.has(tag)) firstBy.set(tag, t);
    for (const [tag, first] of firstBy) {
      const followers = sorted.filter((t) => t.participantId !== first.participantId && t.at >= first.at && t.tags.includes(tag)).length;
      if (followers > 0) credit.set(first.participantId, [...(credit.get(first.participantId) ?? []), { tag, label: first.label, followers }]);
    }
  }
  return credit;
}

export function buildInsights(tastings: InsightTasting[], people: InsightPerson[], viewerParticipantId: string | null): OutingInsights {
  const names = new Map(people.map((p) => [p.participantId, p.name]));
  const mine = tastings.filter((t) => names.has(t.participantId));
  const byPerson = new Map<string, InsightTasting[]>();
  for (const t of mine) byPerson.set(t.participantId, [...(byPerson.get(t.participantId) ?? []), t]);
  const ids = [...byPerson.keys()].sort();

  const pairs: PairSimilarity[] = [];
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const s = pairSimilarity(byPerson.get(ids[i])!, byPerson.get(ids[j])!);
      if (s) pairs.push({ a: ids[i], b: ids[j], ...s });
    }
  const rank = (x: PairSimilarity, y: PairSimilarity) => y.score - x.score || y.shared - x.shared || x.a.localeCompare(y.a) || x.b.localeCompare(y.b);
  pairs.sort(rank);
  const top = pairs[0];
  const twins = top ? { ...top, aName: names.get(top.a)!, bName: names.get(top.b)!, why: pairWhy(top) } : null;
  const mineBest = viewerParticipantId ? pairs.find((p) => p.a === viewerParticipantId || p.b === viewerParticipantId) : undefined;
  const closest = mineBest
    ? (() => {
        const other = mineBest.a === viewerParticipantId ? mineBest.b : mineBest.a;
        return { ...mineBest, name: names.get(other)!, why: pairWhy(mineBest) };
      })()
    : null;

  // Learn from X: descriptors they named first that others then picked up;
  // otherwise the most detailed notes (at least two of them).
  const adopted = picksAdopted(mine);
  let learnFrom: OutingInsights["learnFrom"] = null;
  const bestAdopter = [...adopted.entries()].sort((x, y) => y[1].length - x[1].length || x[0].localeCompare(y[0]))[0];
  if (bestAdopter) {
    const [pid, picks] = bestAdopter;
    const tags = [...new Set(picks.map((p) => tagLabel(p.tag)))].slice(0, 3);
    const followers = Math.max(...picks.map((p) => p.followers));
    learnFrom = {
      participantId: pid,
      name: names.get(pid)!,
      why: `Named ${list(tags)} first${picks[0] ? ` on ${picks[0].label}` : ""}, and ${followers === 1 ? "someone else" : `${followers} others`} picked ${tags.length === 1 ? "it" : "them"} up after.`,
    };
  } else {
    const detail = ids
      .map((pid) => {
        const notes = byPerson.get(pid)!.filter((t) => (t.note ?? "").trim().length >= 12);
        return { pid, notes: notes.length, words: notes.reduce((s, t) => s + (t.note ?? "").trim().split(/\s+/).length, 0) };
      })
      .filter((d) => d.notes >= 2)
      .sort((x, y) => y.words - x.words || x.pid.localeCompare(y.pid))[0];
    if (detail) learnFrom = { participantId: detail.pid, name: names.get(detail.pid)!, why: "Wrote the most detailed tasting notes of the group." };
  }

  // Per-bottle stats.
  const byKey = new Map<string, InsightTasting[]>();
  for (const t of mine) byKey.set(t.key, [...(byKey.get(t.key) ?? []), t]);
  const bottles = [...byKey.entries()].map(([key, ts]) => {
    const rated = ts.filter((t) => t.rating != null);
    const rs = rated.map((t) => t.rating!);
    return { key, label: ts[0].label, ts, rated, mean: rs.length ? mean(rs) : null, low: rs.length ? Math.min(...rs) : 0, high: rs.length ? Math.max(...rs) : 0 };
  });
  const favB = bottles
    .filter((b) => b.rated.length >= 2)
    .sort((x, y) => (y.mean ?? 0) - (x.mean ?? 0) || y.rated.length - x.rated.length || x.label.localeCompare(y.label, undefined, { sensitivity: "base" }))[0];
  const favourite = favB ? { key: favB.key, label: favB.label, average: Math.round(favB.mean! * 10) / 10, raters: favB.rated.length } : null;
  const divB = bottles
    .filter((b) => b.rated.length >= 2 && b.high - b.low >= DIVISIVE_SPREAD)
    .sort((x, y) => y.high - y.low - (x.high - x.low) || x.label.localeCompare(y.label))[0];
  const divisive = divB
    ? { key: divB.key, label: divB.label, low: divB.low, high: divB.high, why: `Ratings ran from ${stars(divB.low)} to ${stars(divB.high)} stars.` }
    : null;
  const agreed = bottles
    .map((b) => {
      const count = new Map<string, number>();
      for (const t of b.ts) for (const tag of new Set(t.tags)) count.set(tag, (count.get(tag) ?? 0) + 1);
      const need = Math.max(2, Math.ceil(b.ts.length / 2));
      const tags = [...count.entries()]
        .filter(([, n]) => n >= need)
        .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
        .slice(0, 4)
        .map(([t]) => leafLabel(t) ?? t);
      return { key: b.key, label: b.label, tags };
    })
    .filter((b) => b.tags.length > 0);

  // Called it: the first person to give the eventual favourite its top score,
  // when at least two others rated it after them.
  let calledIt: OutingInsights["calledIt"] = null;
  if (favB && favB.rated.length >= 3) {
    const sorted = [...favB.rated].sort((x, y) => x.at - y.at);
    const first = sorted.find((t) => t.rating === favB.high)!;
    const after = sorted.filter((t) => t.at > first.at).length;
    if (after >= 2) calledIt = { participantId: first.participantId, name: names.get(first.participantId)!, label: favB.label, why: `Gave ${favB.label} ${stars(first.rating!)} stars before anyone else, and it became the group favourite.` };
  }

  const any = twins || learnFrom || favourite || divisive || agreed.length || calledIt;
  return {
    waiting: any ? null : `Insights show up once two people have rated at least ${MIN_SHARED_BOTTLES} of the same bottles.`,
    twins,
    closest,
    learnFrom,
    favourite,
    divisive,
    agreed,
    calledIt,
  };
}

export interface Recognition {
  id: "sharpest_nose" | "palate_twins" | "called_it" | "best_note" | "explorer";
  title: string;
  who: string;
  why: string;
}

/**
 * The recap's earned recognitions: one card each, at most one winner, and only
 * when there's a clear reason. About tasting, notes and agreement — never
 * streaks, volume, how many bottles or pours, or who drank what.
 */
export function buildRecognitions(
  insights: OutingInsights,
  tastings: InsightTasting[],
  people: InsightPerson[],
  /** Great-note / learned-something reactions on each tasting note, by its author. */
  noteAppreciation: Array<{ participantId: string; label: string; count: number }> = [],
): Recognition[] {
  const names = new Map(people.map((p) => [p.participantId, p.name]));
  const out: Recognition[] = [];
  if (insights.learnFrom) out.push({ id: "sharpest_nose", title: "Sharpest nose", who: insights.learnFrom.name, why: insights.learnFrom.why });
  if (insights.twins) out.push({ id: "palate_twins", title: "Palate twins", who: `${insights.twins.aName} & ${insights.twins.bName}`, why: insights.twins.why });
  if (insights.calledIt) out.push({ id: "called_it", title: "Called it", who: insights.calledIt.name, why: insights.calledIt.why });
  const best = [...noteAppreciation].filter((n) => names.has(n.participantId) && n.count > 0).sort((x, y) => y.count - x.count || x.participantId.localeCompare(y.participantId));
  if (best[0] && (best.length === 1 || best[0].count > best[1].count))
    out.push({ id: "best_note", title: "Best note", who: names.get(best[0].participantId)!, why: `The group marked their note on ${best[0].label} as one to remember.` });
  // Explorer: descriptors nobody else named on the same bottle.
  const own = new Map<string, Set<string>>();
  const byKey = new Map<string, InsightTasting[]>();
  for (const t of tastings) if (names.has(t.participantId)) byKey.set(t.key, [...(byKey.get(t.key) ?? []), t]);
  for (const ts of byKey.values())
    for (const t of ts)
      for (const tag of t.tags)
        if (!ts.some((o) => o.participantId !== t.participantId && o.tags.includes(tag))) own.set(t.participantId, (own.get(t.participantId) ?? new Set()).add(tag));
  const ex = [...own.entries()].map(([pid, s]) => ({ pid, n: s.size, tags: [...s] })).sort((x, y) => y.n - x.n || x.pid.localeCompare(y.pid));
  if (ex[0] && ex[0].n >= 3 && (ex.length === 1 || ex[0].n > ex[1].n))
    out.push({ id: "explorer", title: "Explorer", who: names.get(ex[0].pid)!, why: `Found flavours nobody else named, like ${list(ex[0].tags.slice(0, 3).map(tagLabel))}.` });
  return out;
}
