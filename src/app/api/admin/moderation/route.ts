import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { REPORT_SUBJECT_TYPES } from "@/db/schema";
import { getSessionUser, withErrorHandling, UnauthorizedError } from "@/lib/session";
import { readJsonWithinLimit } from "@/lib/body-limit";
import { isOperator } from "@/lib/operator";
import {
  UnknownSubjectError,
  dismissReport,
  hideSubject,
  reinstateAccount,
  resolveReport,
  suspendAccount,
} from "@/lib/moderation";

export const runtime = "nodejs";

/** An id, an action and a sentence of reasoning. */
const MAX_BODY_BYTES = 4 * 1024;

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("hide"),
    subjectType: z.enum(REPORT_SUBJECT_TYPES),
    subjectId: z.string().min(1),
    reportId: z.string().min(1).optional(),
    note: z.string().max(1000).optional(),
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
    if (!user) throw new UnauthorizedError();
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
        await hideSubject(db, user.id, input.subjectType, input.subjectId, {
          reportId: input.reportId,
          note: input.note,
        });
        if (input.reportId) await resolveReport(db, input.reportId);
      } else if (input.action === "suspend") {
        await suspendAccount(db, user.id, input.userId, input.reason, {
          reportId: input.reportId,
        });
        if (input.reportId) await resolveReport(db, input.reportId);
      } else if (input.action === "reinstate") {
        await reinstateAccount(db, user.id, input.userId, input.note);
      } else {
        await dismissReport(db, user.id, input.reportId, input.note);
      }
    } catch (err) {
      if (err instanceof UnknownSubjectError) {
        return NextResponse.json({ error: "Nothing to act on" }, { status: 404 });
      }
      throw err;
    }

    return NextResponse.json({ ok: true });
  }) as Promise<NextResponse>;
}
