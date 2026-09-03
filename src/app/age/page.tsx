import Link from "next/link";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { getAgeGateState, minimumAgeFor, OFFERED_MARKETS } from "@/lib/age-gate";
import { getSessionUser } from "@/lib/session";
import { safeReturnPath } from "@/lib/return-path";
import { AgeGateForm } from "./age-gate-form";
import { SignOutButton } from "./sign-out-button";

export const dynamic = "force-dynamic";

/**
 * The legal-age gate (PLAN.md §9.1; review PLAN-C8, PLAN-A7).
 *
 * Reached by redirect from the root layout for any signed-in account without
 * an answer on file. Three states and no fourth: no answer yet (ask), an
 * answer that fails (say when it stops failing, and offer the resources page
 * and the door), an answer that passes (go where you were headed).
 */
export default async function AgePage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const user = await getSessionUser();
  const params = await searchParams;
  const raw = Array.isArray(params.next) ? params.next[0] : params.next;
  const next = safeReturnPath(raw) ?? "/";

  if (!user) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60dvh] px-6 text-center gap-5">
        <div aria-hidden className="text-5xl">🥃</div>
        <h1 className="font-display text-2xl font-semibold">Sign in first</h1>
        <Link href="/sign-in" className="btn-primary px-8 py-3">
          Sign in
        </Link>
      </div>
    );
  }

  const state = await getAgeGateState(getDb(), user.id);
  if (state.status === "verified") redirect(next);

  if (state.status === "blocked") {
    return (
      <div className="px-4 py-10 max-w-lg mx-auto w-full flex flex-col gap-5 text-center">
        <div aria-hidden className="text-5xl">🥃</div>
        <h1 className="font-display text-2xl font-semibold">Not just yet</h1>
        <p className="text-muted leading-relaxed">
          Whaikey is for people over {state.record.minimumAge} where you are. Based on what you
          told us, that&apos;s{" "}
          {state.eligibleOn ? (
            <>
              you on <strong className="text-foreground">{formatDate(state.eligibleOn)}</strong>
            </>
          ) : (
            "not yet you"
          )}
          . Nothing has been logged to this account, and you can sign in again then.
        </p>
        <p className="text-sm text-muted leading-relaxed">
          If that date is wrong, we can&apos;t change it from here —{" "}
          <Link href="/responsible" className="text-accent font-medium">
            drinking&nbsp;responsibly
          </Link>{" "}
          has the ways to reach us.
        </p>
        <SignOutButton className="btn-secondary px-6 py-3 self-center" />
      </div>
    );
  }

  return (
    <AgeGateForm
      markets={OFFERED_MARKETS}
      minimumsByMarket={Object.fromEntries(
        OFFERED_MARKETS.map((m) => [m.code, minimumAgeFor(m.code)]),
      )}
      next={next}
    />
  );
}

function formatDate(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}
