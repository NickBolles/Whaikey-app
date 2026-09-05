import { and, eq, gte, lt, sql } from "drizzle-orm";
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
 * So this module adds as little new collection as the questions allow, and it
 * is worth listing exactly rather than waving at, because an earlier version
 * of this paragraph said "one table" and stayed that way while the list grew:
 * `analytics_events` for the S1 funnel (reads leave no trace, so it genuinely
 * has no home), `ai_usage` for the cost meter, and four columns that snapshot
 * a fact at the moment it was true — `pours.shelf_relationship_at_pour`,
 * `pours.visibility_at_creation`, `pours.first_shared_at` and
 * `reactions.retracted_at`. Everything else is SQL over tables that already
 * existed.
 *
 * The columns are the interesting part of that list: each exists because
 * reading CURRENT state to describe a PAST event gave an answer that changed
 * depending on when it was asked. None of them records anything the row did
 * not already imply; they record WHEN, so the answer stops moving. An event
 * pipeline that re-recorded pour timestamps into a second table would instead
 * be collecting a drinker's consumption history twice to answer a question
 * the first copy already answers — which is why the one remaining gap
 * (§7's deleted-pour note) is still open rather than quietly built.
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
  /**
   * Reports per 1,000 social actions — a pour becoming visible to others, a
   * comment, a cheer.
   *
   * The denominator counts what HAPPENED, not what still stands: a comment
   * that was since deleted, a cheer since retracted, and a pour since made
   * private all remain in it. That is deliberate and is most of the work in
   * this file. Counting only surviving rows meant the denominator shrank
   * exactly when somebody stepped back or was suspended — which is when the
   * numerator is highest — so the safety metric spiked because of the safety
   * action.
   */
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

  /**
   * Tried vs owned, from the snapshot taken WHEN THE POUR HAPPENED.
   *
   * The first version joined `user_bottles` and read `relationship` today.
   * That row moves from `tried` to `own` the moment somebody buys a bottle
   * they had only sampled, so every earlier sample of it was retroactively
   * reclassified as an owned pour — and a ratio §12 says "should rise" could
   * fall with nobody drinking or logging anything. Reading current state to
   * describe a past event is not measuring the past.
   *
   * Rows without a snapshot are excluded rather than falling back to the live
   * join, because the fallback IS the bug. A pour whose snapshot is null but
   * which has no shelf row at all is still `tried` — that is the bar sample
   * the ratio exists to reward, and its absence from the shelf is itself the
   * fact, not a missing reading.
   */
  const [ratioRow] = await db
    .select({
      owned: sql<number>`count(*) filter (where ${schema.pours.shelfRelationshipAtPour} = 'own')`,
      tried: sql<number>`count(*) filter (where ${schema.pours.shelfRelationshipAtPour} is not null and ${schema.pours.shelfRelationshipAtPour} <> 'own')`,
    })
    .from(schema.pours)
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

  /**
   * Pours that became visible to other people, counted at the moment they did.
   *
   * Two failed attempts are worth keeping in view. Counting CURRENT visibility
   * was wrong because `makeEverythingPrivate` and a suspension rewrite every
   * one of an account's pours to `private` in bulk, erasing social actions
   * that demonstrably happened — shrinking this denominator exactly when the
   * reports-per-1,000 numerator is highest, so the safety metric spiked
   * because of the safety action. Counting the CREATION snapshot fixed that
   * and broke the mirror image: pours default to private and are published
   * later, so the moment one actually crossed to other people was never
   * counted at all.
   *
   * `first_shared_at` is that moment, written once on the first private →
   * visible transition and never moved afterwards. Note the window is on
   * `first_shared_at`, not `created_at`: a pour logged in January and shared
   * in March is a March social action, because March is when a reader could
   * see it.
   */
  const [socialRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.pours)
    .where(
      and(
        gte(schema.pours.firstSharedAt, since),
        lt(schema.pours.firstSharedAt, until),
      ),
    );
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
  /**
   * Social-off is a metric about people CHOOSING to leave, so an operator
   * turning it off for them does not belong in it.
   *
   * `suspendAccount` sets `socialEnabled = false`, and WP-18 deliberately does
   * not restore it on reinstatement — coming back is the account's own choice
   * to make again. Both of those are right, and together they meant a
   * suspension registered permanently as a voluntary step-back, contaminating
   * the guardrail with the moderation actions taken to protect the same
   * people. Anyone ever suspended is excluded from BOTH sides of the share:
   * leaving them in the denominator alone would understate the rate instead.
   */
  const everSuspended = sql`exists (
    select 1 from moderation_actions ma
    where ma.subject_type = 'profile'
      and ma.subject_id = ${schema.userProfiles.userId}
      and ma.action = 'suspend'
  )`;
  /**
   * Both rates are counted over the SAME rows, which is the only reason they
   * can be read as shares of one population.
   *
   * `blockRate` used to divide `count(distinct blocker_id)` over the whole
   * `blocks` table by a denominator the suspension filter had already
   * narrowed — a numerator drawn from a wider set than its denominator, so the
   * "rate" could exceed 1 and, more quietly, drifted upward every time an
   * operator suspended somebody. That was introduced by the fix that added the
   * exclusion in the first place: it reached the metric the finding named and
   * left its neighbour on the next line reading from the old population.
   * Expressed as an `exists` over `user_profiles` instead, the numerator is a
   * subset of the denominator by construction rather than by care.
   */
  const hasBlocked = sql`exists (
    select 1 from blocks b where b.blocker_id = ${schema.userProfiles.userId}
  )`;
  const [profileRow] = await db
    .select({
      profiles: sql<number>`count(*) filter (where not ${everSuspended})`,
      off: sql<number>`count(*) filter (where ${schema.userProfiles.socialEnabled} = false and not ${everSuspended})`,
      blockers: sql<number>`count(*) filter (where ${hasBlocked} and not ${everSuspended})`,
    })
    .from(schema.userProfiles);

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
    blockRate: profiles === 0 ? null : Number(profileRow?.blockers ?? 0) / profiles,
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
   * Adds from a share that went straight onto the shelf as `own` or `tried`.
   * Kept apart from the wishlist figure rather than folded into it, because
   * the two say different things about the link: one is "I want this", the
   * other is "I have this, and now you know we overlap".
   */
  shelfAddsFromShare: number;
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
      // On the recorded classification, NOT on `user_id is not null`. The id
      // is detached when an account is deleted, and reading it here would have
      // moved this denominator retroactively -- turning a past month's
      // comparisonRate into a different number because somebody left.
      signedIn: sql<number>`count(*) filter (where ${schema.analyticsEvents.name} = 'share_view' and ${schema.analyticsEvents.bySignedInUser})`,
      comparisons: sql<number>`count(*) filter (where ${schema.analyticsEvents.name} = 'share_comparison_rendered')`,
      wishlist: sql<number>`count(*) filter (where ${schema.analyticsEvents.name} = 'share_wishlist_add')`,
      shelf: sql<number>`count(*) filter (where ${schema.analyticsEvents.name} = 'share_shelf_add')`,
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
    shelfAddsFromShare: Number(row?.shelf ?? 0),
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
): Promise<{ aiUsage: number; analyticsEvents: number; retractedCheers: number }> {
  const cutoff = new Date(now.getTime() - TELEMETRY_RETENTION_DAYS * DAY_MS);
  const usage = await db
    .delete(schema.aiUsage)
    .where(lt(schema.aiUsage.createdAt, cutoff))
    .returning({ id: schema.aiUsage.id });
  const events = await db
    .delete(schema.analyticsEvents)
    .where(lt(schema.analyticsEvents.createdAt, cutoff))
    .returning({ id: schema.analyticsEvents.id });
  /**
   * And withdrawn cheers, on the same clock.
   *
   * A retracted cheer survives its retraction for one reason only — so the
   * guardrail window it happened in keeps its number — and that reason expires
   * with the window. Keeping it past then would be holding a social gesture
   * somebody explicitly took back, which is not a retention the privacy page
   * should have to explain. Cut on `retracted_at`, not `created_at`: an old
   * cheer withdrawn yesterday is still inside the window that has to stay
   * stable.
   */
  const cheers = await db
    .delete(schema.reactions)
    .where(lt(schema.reactions.retractedAt, cutoff))
    .returning({ id: schema.reactions.id });
  return {
    aiUsage: usage.length,
    analyticsEvents: events.length,
    retractedCheers: cheers.length,
  };
}
