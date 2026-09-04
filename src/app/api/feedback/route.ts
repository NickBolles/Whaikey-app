import { NextResponse } from "next/server";
import { and, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { feedback } from "@/db/schema";
import { getSessionUser, withErrorHandling } from "@/lib/session";
import { readJsonWithinLimit } from "@/lib/body-limit";

export const runtime = "nodejs";

/** A paragraph, a contact line, and two short strings of device context. */
const MAX_BODY_BYTES = 8 * 1024;

/**
 * How much unauthenticated feedback one client may send in an hour.
 *
 * The support route has to work signed out — somebody who cannot get past the
 * age gate or sign-in is exactly the person who needs it — which means it has
 * to be bounded by something other than an account. Per instance, like the CSP
 * sink: a weaker bound than a shared counter, and still the difference between
 * bounded and unbounded (the durable version is SEC-M3 / WP-25).
 */
const ANON_WINDOW_MS = 60 * 60 * 1000;
const ANON_LIMIT = 5;
let anonWindowStart = 0;
let anonCount = 0;

const bodySchema = z.object({
  body: z.string().trim().min(10).max(4000),
  contact: z.string().trim().max(200).optional(),
  platform: z.string().trim().max(40).optional(),
  appVersion: z.string().trim().max(40).optional(),
});

/**
 * POST /api/feedback — the support channel that is not a GitHub issue form
 * (PLAN.md §9.7; review §5.4 lists its absence as a launch blocker).
 *
 * Stored, not mailed. There is no mailer configured, and an email to an
 * address nobody set up is not a support channel — it is a silent drop with
 * better branding. A row an operator reads at `/admin/feedback` is one.
 *
 * Works signed out on purpose: the person most in need of support is often the
 * one who cannot get in.
 */
export async function POST(request: Request): Promise<NextResponse> {
  return withErrorHandling(async () => {
    const user = await getSessionUser();

    const raw = await readJsonWithinLimit(request, MAX_BODY_BYTES);
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.issues.map((i) => i.message) },
        { status: 400 },
      );
    }

    const db = getDb();
    const now = new Date();

    if (!user) {
      if (now.getTime() - anonWindowStart >= ANON_WINDOW_MS) {
        anonWindowStart = now.getTime();
        anonCount = 0;
      }
      if (anonCount >= ANON_LIMIT) {
        return NextResponse.json(
          { error: "Too many messages just now — try again shortly." },
          { status: 429 },
        );
      }
      anonCount++;
    } else {
      const hourAgo = new Date(now.getTime() - ANON_WINDOW_MS);
      const [row] = await db
        .select({ n: sql<number>`count(*)` })
        .from(feedback)
        .where(and(sql`${feedback.userId} = ${user.id}`, gt(feedback.createdAt, hourAgo)));
      if (Number(row?.n ?? 0) >= ANON_LIMIT) {
        return NextResponse.json(
          { error: "Too many messages just now — try again shortly." },
          { status: 429 },
        );
      }
    }

    await db.insert(feedback).values({
      id: crypto.randomUUID(),
      userId: user?.id ?? null,
      body: parsed.data.body,
      contact: parsed.data.contact || null,
      platform: parsed.data.platform || null,
      appVersion: parsed.data.appVersion || null,
      createdAt: now,
    });

    return NextResponse.json({ received: true }, { status: 201 });
  }) as Promise<NextResponse>;
}
