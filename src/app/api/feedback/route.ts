import { NextResponse } from "next/server";
import { and, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { feedback } from "@/db/schema";
import { getSessionUser, withErrorHandling } from "@/lib/session";
import { readJsonWithinLimit } from "@/lib/body-limit";

export const runtime = "nodejs";

/** A paragraph, a contact line, and two short strings of device context. */
const MAX_BODY_BYTES = 8 * 1024;

const WINDOW_MS = 60 * 60 * 1000;

/** What one signed-in account may send in an hour. Durable, counted in the table. */
const PER_USER_LIMIT = 5;

/**
 * The signed-out bound.
 *
 * The support route has to work signed out — somebody who cannot get past the
 * age gate or sign-in is exactly the person who needs it — so it has to be
 * bounded by something other than an account. There is no IP-keyed durable
 * limiter yet (`ai_rate_limits` is keyed to a user row; the durable version is
 * SEC-M3 / WP-25), so this is in-memory and per instance.
 *
 * Per client, keyed on the forwarded address, **not one counter for everybody**:
 * a single global allowance of a handful an hour would turn the one event this
 * channel exists for — an outage many people report at once — into a silent
 * drop for everybody after the fifth. So the per-client bound is tight and the
 * instance-wide bound is only a flood ceiling. Both are best-effort by
 * construction: an instance restarts, and a forwarded address can be spoofed.
 * They bound accidental repetition and casual spam, which is what an in-memory
 * counter can honestly claim.
 */
const PER_CLIENT_LIMIT = 5;
const INSTANCE_LIMIT = 500;
/** Bounded so a stream of distinct addresses cannot grow this without limit. */
const MAX_TRACKED_CLIENTS = 5_000;

const clientCounts = new Map<string, { windowStart: number; count: number }>();
let instanceWindowStart = 0;
let instanceCount = 0;

/** The client's address as the proxy reported it, or null when there is none. */
function clientKey(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || request.headers.get("x-real-ip")?.trim() || null;
}

/** True when this anonymous request is over either bound. */
function anonThrottled(request: Request, now: number): boolean {
  if (now - instanceWindowStart >= WINDOW_MS) {
    instanceWindowStart = now;
    instanceCount = 0;
    // The per-client map is only meaningful within a window, so it rolls with it.
    clientCounts.clear();
  }
  if (instanceCount >= INSTANCE_LIMIT) return true;

  const key = clientKey(request);
  if (key) {
    const seen = clientCounts.get(key);
    if (seen && now - seen.windowStart < WINDOW_MS) {
      if (seen.count >= PER_CLIENT_LIMIT) return true;
      seen.count++;
    } else if (clientCounts.size < MAX_TRACKED_CLIENTS) {
      clientCounts.set(key, { windowStart: now, count: 1 });
    }
  }

  instanceCount++;
  return false;
}

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

    const tooMany = NextResponse.json(
      { error: "Too many messages just now — try again shortly." },
      { status: 429 },
    );

    if (!user && anonThrottled(request, now.getTime())) return tooMany;

    const row = {
      id: crypto.randomUUID(),
      userId: user?.id ?? null,
      body: parsed.data.body,
      contact: parsed.data.contact || null,
      platform: parsed.data.platform || null,
      appVersion: parsed.data.appVersion || null,
      createdAt: now,
    };

    if (!user) {
      await db.insert(feedback).values(row);
      return NextResponse.json({ received: true }, { status: 201 });
    }

    /**
     * Count and insert in one transaction behind a per-user advisory lock, the
     * same shape as the report and submission limiters. Counting outside the
     * write lets several concurrent requests all read four-of-five and all
     * insert, which is the difference between a durable bound and a bound that
     * holds only when nobody tries.
     */
    const accepted = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`feedback-rl:${user.id}`}))`);
      const hourAgo = new Date(now.getTime() - WINDOW_MS);
      const [counted] = await tx
        .select({ n: sql<number>`count(*)` })
        .from(feedback)
        .where(and(eq(feedback.userId, user.id), gt(feedback.createdAt, hourAgo)));
      if (Number(counted?.n ?? 0) >= PER_USER_LIMIT) return false;
      await tx.insert(feedback).values(row);
      return true;
    });
    if (!accepted) return tooMany;

    return NextResponse.json({ received: true }, { status: 201 });
  }) as Promise<NextResponse>;
}
