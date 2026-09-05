import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { schema } from "@/db";
import { meanAiCostPerActiveUser, aiCostSince, type AiCostRow } from "@/lib/ai/usage";

/**
 * The numbers this product committed to watching, computed (WP-19).
 *
 * **The gap was never the data.** `docs/SOCIAL.md` §12 calls its guardrails
 * "a smoke alarm", PLAN-A5 says the S1 overlap "was never measured and S2/S3
 * shipped anyway", and the review filed both as unmeasured — but almost every
 * one of them is a query over `pours`, `user_bottles`, `reports`, `blocks` and
 * `user_profiles` exactly as they already stand. Nobody had written the
 * queries. That is a smaller failure than "we cannot know" and a worse one,
 * because it was always answerable and the answer was never asked for.
 *
 * So this module adds almost no new data collection: one table for the S1
 * share funnel, which genuinely has no home because reads leave no trace, and
 * SQL for the rest. An event pipeline that re-recorded pour timestamps into a
 * second table would be collecting a drinker's consumption history twice to
 * answer a question the first copy already answers.
 *
 * **These are operator numbers and may never be rendered to a user.** AGENTS.md
 * and SOCIAL §3.1 ban a displayed count of how much or how often somebody
 * drank; "pours per active user per week" is precisely that shape. The
 * asymmetry is deliberate and is the point of a guardrail: we are required to
 * watch the number we are forbidden to show. Anything reading this module
 * belongs behind the operator check.
 */

const DAY_MS = 86_400_000;

export interface GuardrailMetrics {
  /** The window these cover, so a reader cannot mistake a fortnight for a week. */
  since: Date;
  until: Date;
  /**
   * SOCIAL §12: pours logged per active user per week. **A rise triggers
   * investigation, not a freeze** — logging is not drinking, and better
   * capture (import, scanning, the app simply getting good) raises this while
   * actual consumption is flat. The doc is explicit that the earlier
   * ship-blocker version "punishes the app for working".
   */
  poursPerActiveUserPerWeek: number;
  activeUsers: number;
  pours: number;
  /**
   * Tried-to-owned pour ratio: should RISE. Breadth over volume is the thesis,
   * and a pour of something you own is the volume side of it.
   */
  triedToOwnedPourRatio: number | null;
  triedPours: number;
  ownedPours: number;
  /** Reports per 1,000 social actions (pours visible to others, comments, cheers). */
  reportsPerThousandSocialActions: number | null;
  socialActions: number;
  reports: number;
  /**
   * The same figure with accounts that JOINED during the window removed —
   * the cohort adjustment `docs/SOCIAL.md` §12 actually asks for.
   *
   * A new account logs its backlog: the bottles it already owns, the pours it
   * remembers. That is one person's history arriving in one week, and it lifts
   * the raw average during any period of growth without anybody drinking more.
   * §12 names that confounder and requires the metric be cohort-adjusted, and
   * the first version of this module shipped the raw aggregate with the
   * confounder merely *described* in a comment — which is not the same as
   * removing it. Established accounts are the population comparable across
   * releases; the raw figure stays beside it because the two diverging IS the
   * signal that growth rather than behaviour moved the number.
   */
  establishedPoursPerActiveUserPerWeek: number | null;
  establishedActiveUsers: number;
  establishedPours: number;
  /** Share of accounts with a profile that currently have social switched off. */
  socialOffRate: number | null;
  /** Share of accounts with a profile that have blocked at least one person. */
  blockRate: number | null;
  profiles: number;
}

/**
 * Guardrail metrics over a window (default: the last 7 days).
 *
 * "Active" is an account that logged at least one pour in the window. That is
 * a narrow definition and the honest one available: without a session marker
 * there is no record of somebody who opened the app and read — see
 * `sessionsWithoutAPour` below for why that metric is not computed here rather
 * than estimated badly.
 */
export async function guardrailMetrics(
  db: DB,
  opts: { since?: Date; until?: Date } = {},
): Promise<GuardrailMetrics> {
  const until = opts.until ?? new Date();
  const since = opts.since ?? new Date(until.getTime() - 7 * DAY_MS);
  const windowDays = Math.max(1, (until.getTime() - since.getTime()) / DAY_MS);

  const inWindow = and(gte(schema.pours.createdAt, since), lt(schema.pours.createdAt, until));

  const [pourRow] = await db
    .select({
      pours: sql<number>`count(*)`,
      users: sql<number>`count(distinct ${schema.pours.userId})`,
    })
    .from(schema.pours)
    .where(inWindow);

  // Tried vs owned, decided by the viewer's OWN relationship to the bottle at
  // read time. A pour of a bottle absent from the shelf is neither: it is a
  // sample from somewhere else, which counts as tried — that is the breadth
  // case the ratio exists to reward.
  const [ratioRow] = await db
    .select({
      owned: sql<number>`count(*) filter (where ${schema.userBottles.relationship} = 'own')`,
      tried: sql<number>`count(*) filter (where ${schema.userBottles.relationship} is distinct from 'own')`,
    })
    .from(schema.pours)
    .leftJoin(
      schema.userBottles,
      and(
        eq(schema.userBottles.userId, schema.pours.userId),
        eq(schema.userBottles.bottleId, schema.pours.bottleId),
      ),
    )
    .where(inWindow);

  // Cohort-adjusted: accounts that existed BEFORE the window opened, so a
  // backlog logged by somebody who joined on Tuesday cannot move it.
  const [establishedRow] = await db
    .select({
      pours: sql<number>`count(*)`,
      users: sql<number>`count(distinct ${schema.pours.userId})`,
    })
    .from(schema.pours)
    .innerJoin(schema.user, eq(schema.user.id, schema.pours.userId))
    .where(and(inWindow, lt(schema.user.createdAt, since)));

  const [socialRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.pours)
    .where(and(inWindow, inArray(schema.pours.visibility, ["public", "friends", "followers"])));
  const [commentRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.comments)
    .where(and(gte(schema.comments.createdAt, since), lt(schema.comments.createdAt, until)));
  const [cheerRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.reactions)
    .where(and(gte(schema.reactions.createdAt, since), lt(schema.reactions.createdAt, until)));
  const [reportRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.reports)
    .where(and(gte(schema.reports.createdAt, since), lt(schema.reports.createdAt, until)));

  // These two are STATE, not events, so they are current shares rather than
  // windowed rates: nothing records when social was switched off, only that it
  // is. Saying so is better than presenting a lifetime figure as a weekly one.
  const [profileRow] = await db
    .select({
      profiles: sql<number>`count(*)`,
      off: sql<number>`count(*) filter (where ${schema.userProfiles.socialEnabled} = false)`,
    })
    .from(schema.userProfiles);
  const [blockerRow] = await db
    .select({ n: sql<number>`count(distinct ${schema.blocks.blockerId})` })
    .from(schema.blocks);

  const pours = Number(pourRow?.pours ?? 0);
  const activeUsers = Number(pourRow?.users ?? 0);
  const establishedPours = Number(establishedRow?.pours ?? 0);
  const establishedActiveUsers = Number(establishedRow?.users ?? 0);
  const ownedPours = Number(ratioRow?.owned ?? 0);
  const triedPours = Number(ratioRow?.tried ?? 0);
  const socialActions =
    Number(socialRow?.n ?? 0) + Number(commentRow?.n ?? 0) + Number(cheerRow?.n ?? 0);
  const reports = Number(reportRow?.n ?? 0);
  const profiles = Number(profileRow?.profiles ?? 0);

  return {
    since,
    until,
    pours,
    activeUsers,
    poursPerActiveUserPerWeek:
      activeUsers === 0 ? 0 : (pours / activeUsers) * (7 / windowDays),
    establishedPours,
    establishedActiveUsers,
    establishedPoursPerActiveUserPerWeek:
      establishedActiveUsers === 0
        ? null
        : (establishedPours / establishedActiveUsers) * (7 / windowDays),
    ownedPours,
    triedPours,
    triedToOwnedPourRatio: ownedPours === 0 ? null : triedPours / ownedPours,
    socialActions,
    reports,
    reportsPerThousandSocialActions:
      socialActions === 0 ? null : (reports / socialActions) * 1000,
    profiles,
    socialOffRate: profiles === 0 ? null : Number(profileRow?.off ?? 0) / profiles,
    blockRate: profiles === 0 ? null : Number(blockerRow?.n ?? 0) / profiles,
  };
}

export interface ShareFunnel {
  since: Date;
  until: Date;
  /** Links whose page was opened at all. */
  views: number;
  viewsBySignedInUsers: number;
  comparisonsRendered: number;
  wishlistAddsFromShare: number;
  /**
   * The PLAN-A5 question in one number: of the signed-in people who opened a
   * share link, what share saw a comparison? A share link viewed by someone
   * with no pours of their own has nothing to compare, and the sparse-overlap
   * risk S1 was meant to test is exactly how often that happens.
   */
  comparisonRate: number | null;
}

/** The S1 overlap funnel (PLAN-A5), over a window (default: 30 days). */
export async function shareFunnel(
  db: DB,
  opts: { since?: Date; until?: Date } = {},
): Promise<ShareFunnel> {
  const until = opts.until ?? new Date();
  const since = opts.since ?? new Date(until.getTime() - 30 * DAY_MS);
  const [row] = await db
    .select({
      views: sql<number>`count(*) filter (where ${schema.analyticsEvents.name} = 'share_view')`,
      signedIn: sql<number>`count(*) filter (where ${schema.analyticsEvents.name} = 'share_view' and ${schema.analyticsEvents.userId} is not null)`,
      comparisons: sql<number>`count(*) filter (where ${schema.analyticsEvents.name} = 'share_comparison_rendered')`,
      wishlist: sql<number>`count(*) filter (where ${schema.analyticsEvents.name} = 'share_wishlist_add')`,
    })
    .from(schema.analyticsEvents)
    .where(
      and(
        gte(schema.analyticsEvents.createdAt, since),
        lt(schema.analyticsEvents.createdAt, until),
      ),
    );

  const signedIn = Number(row?.signedIn ?? 0);
  const comparisons = Number(row?.comparisons ?? 0);
  return {
    since,
    until,
    views: Number(row?.views ?? 0),
    viewsBySignedInUsers: signedIn,
    comparisonsRendered: comparisons,
    wishlistAddsFromShare: Number(row?.wishlist ?? 0),
    comparisonRate: signedIn === 0 ? null : comparisons / signedIn,
  };
}

/**
 * The one §12 metric this does NOT compute, named so it is a decision.
 *
 * "Share of sessions with no pour logged (should rise)" needs a record that
 * somebody opened the app and read something, and nothing here records reads.
 * Building it means an app-open event per account — a behavioural timeline of
 * when a person opens a drinking app, which is a new and genuinely sensitive
 * category of data on a product whose first promise is that the journal is
 * private. That is the owner's call, not a side effect of writing a metrics
 * module, and it needs a Privacy Policy entry either way (PLAN §12).
 *
 * An estimate is deliberately not offered in its place. A guardrail read off a
 * proxy nobody validated is worse than a blank, because the blank is honest
 * about not knowing.
 */
export const SESSIONS_WITHOUT_A_POUR_STATUS =
  "Not measured: needs an app-open event, which is an owner decision (PLAN §12).";

export interface OperatorMetrics {
  guardrails: GuardrailMetrics;
  shares: ShareFunnel;
  aiCostByFeature: AiCostRow[];
  aiCostPerActiveUser: { users: number; totalUsd: number; meanUsd: number };
  notMeasured: string[];
}

/** Everything WP-19 promised to be able to answer, in one read. */
export async function operatorMetrics(db: DB, opts: { since?: Date } = {}): Promise<OperatorMetrics> {
  const since = opts.since ?? new Date(Date.now() - 30 * DAY_MS);
  const [guardrails, shares, aiCostByFeature, aiCostPerActiveUser] = await Promise.all([
    guardrailMetrics(db),
    shareFunnel(db, { since }),
    aiCostSince(db, since),
    meanAiCostPerActiveUser(db, since),
  ]);
  return {
    guardrails,
    shares,
    aiCostByFeature,
    aiCostPerActiveUser,
    notMeasured: [SESSIONS_WITHOUT_A_POUR_STATUS],
  };
}

/**
 * How long telemetry is kept before it is swept.
 *
 * 90 days, which is a real answer rather than "indefinitely". It is chosen
 * from what the metrics actually need: the guardrail window is a week, the
 * funnel window is a month, and a quarter leaves room to compare this month
 * against the last two — which is the whole point of watching a guardrail.
 * Beyond that these rows answer no question anyone is asking, and an
 * un-swept telemetry table is how "we keep a little operational data" becomes
 * a permanent behavioural record of when somebody drank.
 *
 * WP-18 found a Privacy Policy claim (`ai_rate_limits` being "dropped after a
 * couple of days") that nothing enforced. This is that lesson applied in the
 * other order: the sweep is written first and the policy says what it does.
 */
export const TELEMETRY_RETENTION_DAYS = 90;

/** Drop telemetry past its retention. Returns how many rows went. */
export async function sweepTelemetry(
  db: DB,
  now = new Date(),
): Promise<{ aiUsage: number; analyticsEvents: number }> {
  const cutoff = new Date(now.getTime() - TELEMETRY_RETENTION_DAYS * DAY_MS);
  const usage = await db
    .delete(schema.aiUsage)
    .where(lt(schema.aiUsage.createdAt, cutoff))
    .returning({ id: schema.aiUsage.id });
  const events = await db
    .delete(schema.analyticsEvents)
    .where(lt(schema.analyticsEvents.createdAt, cutoff))
    .returning({ id: schema.analyticsEvents.id });
  return { aiUsage: usage.length, analyticsEvents: events.length };
}
