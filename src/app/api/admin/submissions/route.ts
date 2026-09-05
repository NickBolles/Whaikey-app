import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { getSessionUser, withErrorHandling } from "@/lib/session";
import { readJsonWithinLimit } from "@/lib/body-limit";
import { isOperator } from "@/lib/operator";
import {
  UnknownSubmissionError,
  approveSubmission,
  markSubmissionDuplicate,
  rejectSubmission,
} from "@/lib/catalog";

export const runtime = "nodejs";

/** An id, a decision and a sentence of reasoning. */
const MAX_BODY_BYTES = 4 * 1024;

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("approve"),
    submissionId: z.string().min(1),
    note: z.string().max(1000).optional(),
  }),
  z.object({
    action: z.literal("reject"),
    submissionId: z.string().min(1),
    // Required: a decision the submitter cannot be told the grounds for is one
    // nobody can argue with.
    reason: z.string().trim().min(1).max(1000),
  }),
  z.object({
    action: z.literal("duplicate"),
    submissionId: z.string().min(1),
    duplicateOfBottleId: z.string().min(1),
    note: z.string().max(1000).optional(),
  }),
]);

/**
 * POST /api/admin/submissions — review the catalog queue (PLAN.md §9.4).
 *
 * Separate from `/api/admin/moderation` because they are separate jobs with
 * separate records: that one acts on people's content and writes
 * `moderation_actions`; this one decides what enters the shared catalog and
 * writes its answer onto the submission row. Same operator gate, and the same
 * 404 for everybody else — a 403 would confirm the endpoint exists.
 */
export async function POST(request: Request): Promise<NextResponse> {
  return withErrorHandling(async () => {
    const user = await getSessionUser();
    // One answer for everybody who is not an operator, signed in or not. A 401
    // here and a 404 there lets an anonymous prober tell a real admin endpoint
    // from a wrong URL — which is the whole thing the 404 was for.
    if (!isOperator(user)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await readJsonWithinLimit(request, MAX_BODY_BYTES);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.issues.map((i) => i.message) },
        { status: 400 },
      );
    }
    const input = parsed.data;
    const db = getDb();

    try {
      if (input.action === "approve") {
        await approveSubmission(db, user.id, input.submissionId, input.note);
      } else if (input.action === "reject") {
        await rejectSubmission(db, user.id, input.submissionId, input.reason);
      } else {
        await markSubmissionDuplicate(
          db,
          user.id,
          input.submissionId,
          input.duplicateOfBottleId,
          input.note,
        );
      }
    } catch (err) {
      if (err instanceof UnknownSubmissionError) {
        return NextResponse.json({ error: "Nothing to review at that id" }, { status: 404 });
      }
      throw err;
    }

    return NextResponse.json({ ok: true });
  }) as Promise<NextResponse>;
}
