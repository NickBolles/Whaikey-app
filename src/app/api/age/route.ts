import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { getSessionUser, withErrorHandling, UnauthorizedError } from "@/lib/session";
import { readJsonWithinLimit } from "@/lib/body-limit";
import {
  AgeAnswerAlreadyRecordedError,
  isValidBirthDate,
  OFFERED_MARKETS,
  recordAgeAnswer,
} from "@/lib/age-gate";

export const runtime = "nodejs";

/** A date and a two-letter market; nothing here is prose. */
const MAX_BODY_BYTES = 1024;

const bodySchema = z.object({
  birthDate: z.string().refine(isValidBirthDate, "Enter a real date"),
  market: z.enum(OFFERED_MARKETS.map((m) => m.code) as [string, ...string[]]),
});

/**
 * POST /api/age {birthDate, market} — the one answer this account gets
 * (PLAN.md §9.1).
 *
 * `getSessionUser` rather than `requireUser`, because `requireUser` is where
 * the gate is enforced and this is the route that answers it. Everything else
 * a signed-in account can reach goes through `requireUser` and gets a 403
 * until this succeeds.
 */
export async function POST(request: Request): Promise<NextResponse> {
  return withErrorHandling(async () => {
    const user = await getSessionUser();
    if (!user) throw new UnauthorizedError();

    const body = await readJsonWithinLimit(request, MAX_BODY_BYTES);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.issues.map((i) => i.message) },
        { status: 400 },
      );
    }

    try {
      const state = await recordAgeAnswer(getDb(), user.id, parsed.data);
      return NextResponse.json(
        state.status === "verified"
          ? { status: "verified" }
          : { status: "blocked", eligibleOn: state.eligibleOn },
        { status: state.status === "verified" ? 200 : 403 },
      );
    } catch (err) {
      if (err instanceof AgeAnswerAlreadyRecordedError) {
        // An answer is already on file, so this one changes nothing. Saying so
        // is the point: a gate that accepts a second answer is a gate that
        // asks until it hears what it wants.
        return NextResponse.json(
          {
            status: err.state.status === "verified" ? "verified" : "blocked",
            error: "You've already answered this",
          },
          { status: err.state.status === "verified" ? 200 : 403 },
        );
      }
      throw err;
    }
  }) as Promise<NextResponse>;
}
