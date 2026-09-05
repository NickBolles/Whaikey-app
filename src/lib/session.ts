import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { BodyTooLargeError } from "@/lib/body-limit";
import { captureError } from "@/lib/observability/errors";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  image?: string | null;
}

/**
 * Resolve the signed-in user, or null. All server code goes through this
 * (never through auth.api directly) so tests can mock a single seam.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const { auth } = await import("@/lib/auth");
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return null;
  const { id, name, email, image } = session.user;
  return { id, name, email, image };
}

export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}

export class AgeGateRequiredError extends Error {
  constructor(readonly reason: "unknown" | "blocked") {
    super("Age verification required");
    this.name = "AgeGateRequiredError";
  }
}

/**
 * For API routes: returns the user or throws.
 *
 * The age gate lives here rather than at each write (PLAN.md §9.1). Every
 * route that touches a user's data already comes through this function, so
 * this is the one place that cannot be forgotten — and forgetting it once is
 * how a gate becomes decorative. The two routes that must stay reachable
 * without an answer (the gate itself and sign-out) use `getSessionUser`.
 */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new UnauthorizedError();

  const { getDb } = await import("@/db");
  const { getAgeGateState } = await import("@/lib/age-gate");
  const state = await getAgeGateState(getDb(), user.id);
  if (state.status !== "verified") throw new AgeGateRequiredError(state.status);

  return user;
}

/**
 * Wrap an API handler body: converts UnauthorizedError into a 401 response,
 * an over-limit body into a 413, and unexpected errors into a 500 (with
 * logging).
 */
export async function withErrorHandling<T>(fn: () => Promise<T>): Promise<T | NextResponse> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (err instanceof AgeGateRequiredError) {
      // 403, not 401: the session is fine, the account just has not answered
      // (or has answered and is not old enough). The client sends them to the
      // gate rather than to sign-in, which would be a loop.
      return NextResponse.json(
        { error: "Age verification required", reason: err.reason },
        { status: 403 },
      );
    }
    if (err instanceof BodyTooLargeError) {
      // Handled here rather than at each call site so a route cannot read a
      // body under a limit and then forget to answer for going over it.
      return NextResponse.json({ error: "Request body too large" }, { status: 413 });
    }
    console.error(err);
    // The funnel MOST API routes come through, so monitoring attaches here
    // rather than at ~40 call sites that each have to remember. Not all of
    // them: seven own their own responses and are wrapped with
    // `reportingErrors` instead — the Better Auth catch-all, the three native
    // sign-in handlers, `/api/native/manifest`, `/api/csp-report` and
    // `/api/cron/sweep`. An earlier version of this comment claimed "every
    // route", which was the kind of claim that stops anyone checking; the
    // cron sweep in particular is unattended, so a failure there is invisible
    // by definition. Deliberately NOT awaited: reporting is best-effort and
    // `captureError` never rejects, so waiting on a third party before
    // answering a request that has already failed would turn a 500 into a slow
    // 500. The four handled cases above are not reported — a 401, a 403, a 413
    // are the API working, and paging on them is how an alert gets muted.
    void captureError(err, { where: "api" });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
