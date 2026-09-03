import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import { ageVerifications, type AgeVerification } from "@/db/schema";

/**
 * The legal-age gate (PLAN.md §9.1; review PLAN-C8 and PLAN-A7).
 *
 * `SOCIAL.md` §8.8, `FEATURES.md` §8.3 and `FEATURES.md` §12 all asserted a
 * gate at signup. There wasn't one — no age logic existed anywhere in `src/`,
 * while S4-grade public content was live. It is a store-submission blocker
 * and, more to the point, the one compliance control this product genuinely
 * needs.
 *
 * What this is and is not: an **attestation**, not identity verification. A
 * determined person can type a different birthday, and no cookie or column
 * here pretends otherwise. What it does is ask once, keep the answer, and
 * refuse to let a failing answer be retried into a passing one.
 */

/** The floor when a market isn't listed below — PLAN.md §9.1's "18 most others". */
export const DEFAULT_MINIMUM_AGE = 18;

/**
 * Markets whose drinking age is above the default.
 *
 * Deliberately short and deliberately conservative: it covers the markets the
 * app is being prepared for, and anything unlisted falls back to 18 rather
 * than to a guess. Extending it is a product-owner decision per market (§9.1),
 * taken before the app is offered there — not something to infer from here.
 */
export const MINIMUM_AGE_BY_MARKET: Readonly<Record<string, number>> = {
  US: 21,
  JP: 20,
  KR: 19,
};

/** The markets the gate offers by name; anything else is "Somewhere else". */
export const OFFERED_MARKETS: ReadonlyArray<{ code: string; label: string }> = [
  { code: "US", label: "United States" },
  { code: "CA", label: "Canada" },
  { code: "GB", label: "United Kingdom" },
  { code: "IE", label: "Ireland" },
  { code: "AU", label: "Australia" },
  { code: "NZ", label: "New Zealand" },
  { code: "DE", label: "Germany" },
  { code: "FR", label: "France" },
  { code: "JP", label: "Japan" },
  { code: "OTHER", label: "Somewhere else" },
];

export function minimumAgeFor(market: string): number {
  return MINIMUM_AGE_BY_MARKET[market.toUpperCase()] ?? DEFAULT_MINIMUM_AGE;
}

/** `YYYY-MM-DD`, and a real date — "2026-02-30" is not one. */
export function isValidBirthDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * Whole years between a birth date and a day, by calendar — never by dividing
 * milliseconds, which is wrong across leap years and wrong by a day for
 * anyone born on 29 February.
 */
export function ageOn(birthDate: string, on: Date): number {
  const [year, month, day] = birthDate.split("-").map(Number);
  let age = on.getUTCFullYear() - year;
  const monthNow = on.getUTCMonth() + 1;
  const dayNow = on.getUTCDate();
  if (monthNow < month || (monthNow === month && dayNow < day)) age--;
  return age;
}

/** The `YYYY-MM-DD` on which this birth date reaches `minimum` years. */
export function eligibleOn(birthDate: string, minimum: number): string {
  const [year, month, day] = birthDate.split("-").map(Number);
  const target = new Date(Date.UTC(year + minimum, month - 1, day));
  return target.toISOString().slice(0, 10);
}

export interface AgeGateAnswer {
  birthDate: string;
  market: string;
}

/** The two states an answered account can be in. */
export type AnsweredAgeGateState = Exclude<AgeGateState, { status: "unknown" }>;

export type AgeGateState =
  /** No answer on file: the gate has to be shown. */
  | { status: "unknown" }
  /** Old enough, either at the time of answering or since. */
  | { status: "verified"; record: AgeVerification }
  /** Answered, and not old enough yet. `eligibleOn` is when that changes. */
  | { status: "blocked"; record: AgeVerification; eligibleOn: string | null };

/**
 * What the gate knows about this account.
 *
 * A stored `passed: false` is re-evaluated against today rather than trusted:
 * somebody who answered at 20 in a 21 market is not blocked forever, they are
 * blocked until their birthday. The stored answer is what never changes.
 */
export async function getAgeGateState(
  db: DB,
  userId: string,
  now = new Date(),
): Promise<AgeGateState> {
  const [record] = await db
    .select()
    .from(ageVerifications)
    .where(eq(ageVerifications.userId, userId))
    .limit(1);
  if (!record) return { status: "unknown" };
  if (record.passed) return { status: "verified", record };
  if (ageOn(record.birthDate, now) >= record.minimumAge) {
    return { status: "verified", record };
  }
  return { status: "blocked", record, eligibleOn: record.eligibleOn };
}

export class AgeAnswerAlreadyRecordedError extends Error {
  constructor(readonly state: AgeGateState) {
    super("An age answer is already on file for this account");
    this.name = "AgeAnswerAlreadyRecordedError";
  }
}

/**
 * Record the one answer this account gets.
 *
 * `onConflictDoNothing` rather than an upsert, and the caller is told when
 * nothing was written: a gate you can answer twice is a gate that asks until
 * it hears what it wants.
 */
export async function recordAgeAnswer(
  db: DB,
  userId: string,
  answer: AgeGateAnswer,
  now = new Date(),
): Promise<AnsweredAgeGateState> {
  const market = answer.market.toUpperCase();
  const minimumAge = minimumAgeFor(market);
  const passed = ageOn(answer.birthDate, now) >= minimumAge;

  const [inserted] = await db
    .insert(ageVerifications)
    .values({
      userId,
      birthDate: answer.birthDate,
      market,
      minimumAge,
      passed,
      eligibleOn: passed ? null : eligibleOn(answer.birthDate, minimumAge),
    })
    .onConflictDoNothing({ target: ageVerifications.userId })
    .returning();

  if (!inserted) {
    // Somebody already answered for this account — theirs stands.
    throw new AgeAnswerAlreadyRecordedError(await getAgeGateState(db, userId, now));
  }
  return passed
    ? { status: "verified", record: inserted }
    : { status: "blocked", record: inserted, eligibleOn: inserted.eligibleOn };
}

/**
 * Paths that render without an answer on file.
 *
 * The gate itself, obviously, or it redirects to itself. Sign-in, so an
 * account can be swapped rather than stranded. The resources page, because
 * the one moment somebody most needs it is when they have just been told they
 * are too young. And `/s/<code>` share pages, which are public content a
 * signed-out visitor can already read — gating a signed-in viewer out of a
 * page they could see by signing out protects nobody.
 */
const UNGATED_ROOTS = ["/age", "/sign-in", "/responsible", "/s", "/api"];

/**
 * Matched on whole segments, never as a bare prefix: `/ages-of-whiskey` is not
 * the gate and `/signage` is not sign-in, and a gate that lets those through
 * is a gate anyone can walk around by naming a route carefully.
 */
export function isUngatedPath(pathname: string): boolean {
  return UNGATED_ROOTS.some((root) => pathname === root || pathname.startsWith(`${root}/`));
}
