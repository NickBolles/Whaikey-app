import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { getSessionUser, withErrorHandling } from "@/lib/session";
import { readJsonWithinLimit } from "@/lib/body-limit";
import { isOperator } from "@/lib/operator";
import {
  CannotHideProfileError,
  ReportAlreadyHandledError,
  ReportSubjectMismatchError,
  StaleModerationViewError,
  UnknownSubjectError,
  dismissReport,
  hideSubject,
  reinstateAccount,
  suspendAccount,
  unhideSubject,
} from "@/lib/moderation";

export const runtime = "nodejs";

/** An id, an action and a sentence of reasoning. */
const MAX_BODY_BYTES = 4 * 1024;

/** The report subjects that can be taken down. A profile is suspended instead. */
const HIDEABLE_SUBJECT_TYPES = ["comment", "pour"] as const;

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("hide"),
    // Not every report subject: a profile is suspended, not hidden — hiding
    // one would only turn off a switch its owner can turn back on, while
    // telling the operator they had acted (src/lib/moderation.ts).
    subjectType: z.enum(HIDEABLE_SUBJECT_TYPES),
    subjectId: z.string().min(1),
    reportId: z.string().min(1).optional(),
    // Required, like a suspension's: a hide is not reversible by its owner, so
    // the note is the only thing they have to appeal against, and the Terms
    // say they get one.
    note: z.string().trim().min(1).max(1000),
  }),
  z.object({
    action: z.literal("unhide"),
    subjectType: z.enum(HIDEABLE_SUBJECT_TYPES),
    subjectId: z.string().min(1),
    note: z.string().max(1000).optional(),
    // Which hide the operator was looking at. Required, not optional: a page
    // is a snapshot, a reversal of a decision nobody reviewed is worse than a
    // refused click, and a guard that can be omitted is one a stale client
    // bundle or a replayed request omits.
    expectedActionId: z.string().min(1),
  }),
  z.object({
    action: z.literal("suspend"),
    userId: z.string().min(1),
    // Required, not optional: a suspension the account cannot be told the
    // reason for is one nobody can appeal.
    reason: z.string().trim().min(1).max(1000),
    reportId: z.string().min(1).optional(),
  }),
  z.object({
    action: z.literal("reinstate"),
    userId: z.string().min(1),
    note: z.string().max(1000).optional(),
    /** Which suspension the operator was looking at. Required, same reason. */
    expectedSuspendedAt: z.string().datetime(),
  }),
  z.object({
    action: z.literal("dismiss"),
    reportId: z.string().min(1),
    note: z.string().max(1000).optional(),
  }),
]);

/**
 * POST /api/admin/moderation — work the queue (PLAN.md §9.4).
 *
 * `getSessionUser` rather than `requireUser`, then the operator check: the
 * answer to "not an operator" must be the same as the answer to "not signed
 * in", because a 403 here would tell an anonymous prober that the endpoint
 * exists and who it is for. Everything below is 404 to everybody else.
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
      if (input.action === "hide") {
        // The action, its audit row and the report's transition are one
        // transaction inside hideSubject — resolving afterwards left the
        // content hidden and the report open whenever the second write failed.
        await hideSubject(db, user.id, input.subjectType, input.subjectId, {
          reportId: input.reportId,
          note: input.note,
        });
      } else if (input.action === "unhide") {
        await unhideSubject(
          db,
          user.id,
          input.subjectType,
          input.subjectId,
          input.note,
          input.expectedActionId,
        );
      } else if (input.action === "suspend") {
        await suspendAccount(db, user.id, input.userId, input.reason, {
          reportId: input.reportId,
        });
      } else if (input.action === "reinstate") {
        await reinstateAccount(
          db,
          user.id,
          input.userId,
          input.note,
          input.expectedSuspendedAt,
        );
      } else {
        await dismissReport(db, user.id, input.reportId, input.note);
      }
    } catch (err) {
      if (err instanceof UnknownSubjectError) {
        return NextResponse.json({ error: "Nothing to act on" }, { status: 404 });
      }
      if (err instanceof StaleModerationViewError) {
        // The page is out of date, not wrong to ask. 409 and a refresh shows
        // what is actually in force.
        return NextResponse.json(
          { error: "That decision has changed — reload the queue." },
          { status: 409 },
        );
      }
      if (err instanceof ReportSubjectMismatchError) {
        return NextResponse.json(
          { error: "That report is not about the thing being acted on" },
          { status: 400 },
        );
      }
      if (err instanceof ReportAlreadyHandledError) {
        // Somebody else got there first, and the whole action rolled back with
        // the claim. 409 rather than 404: the report exists, it is just no
        // longer yours to act on.
        return NextResponse.json({ error: "Already handled by someone else" }, { status: 409 });
      }
      if (err instanceof CannotHideProfileError) {
        return NextResponse.json(
          { error: "A profile is suspended, not hidden" },
          { status: 400 },
        );
      }
      throw err;
    }

    return NextResponse.json({ ok: true });
  }) as Promise<NextResponse>;
}
