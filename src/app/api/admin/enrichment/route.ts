import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { bottles } from "@/db/schema";
import { readJsonWithinLimit } from "@/lib/body-limit";
import { BATCH_TIERS, runBatch } from "@/lib/enrich/batch";
import { updateSettings } from "@/lib/enrich/budget";
import { kick } from "@/lib/enrich/kick";
import { enrichLive } from "@/lib/enrich/providers";
import { requeueBottle, retryFailedJobs, runNextStep } from "@/lib/enrich/queue";
import { isOperator } from "@/lib/operator";
import { getSessionUser, withErrorHandling } from "@/lib/session";

export const runtime = "nodejs";
export const maxDuration = 60;

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("settings"),
    paused: z.boolean().optional(),
    dailyBudgetUsd: z.number().min(0).max(100).optional(),
  }),
  z.object({ action: z.literal("run"), tiers: z.array(z.enum(BATCH_TIERS)).min(1) }),
  z.object({ action: z.literal("retry-failed") }),
  z.object({ action: z.literal("reenrich"), bottleId: z.string().trim().min(1).max(100) }),
]);

/**
 * POST /api/admin/enrichment — operator controls for /admin/enrichment.
 * 404 for everybody else (a 403 would confirm the endpoint exists).
 */
export async function POST(request: Request): Promise<NextResponse> {
  return withErrorHandling(async () => {
    const user = await getSessionUser();
    if (!isOperator(user)) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const parsed = bodySchema.safeParse(await readJsonWithinLimit(request, 4 * 1024));
    if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    const db = getDb();
    const input = parsed.data;
    switch (input.action) {
      case "settings":
        return NextResponse.json({ settings: await updateSettings(db, { paused: input.paused, dailyBudgetUsd: input.dailyBudgetUsd }) });
      case "run": {
        // Free tiers (keyword) run even when model calls are blocked; the
        // budget gate stops each model tier and the run records why.
        return NextResponse.json(await runBatch(db, { trigger: "admin", tiers: input.tiers, budgetMs: 50_000 }));
      }
      case "retry-failed":
        return NextResponse.json({ requeued: await retryFailedJobs(db) });
      case "reenrich": {
        if (!enrichLive()) return NextResponse.json({ error: "No provider key configured or ENRICH_ENABLED is off" }, { status: 409 });
        const [exists] = await db.select({ id: bottles.id }).from(bottles).where(eq(bottles.id, input.bottleId));
        if (!exists) return NextResponse.json({ error: "Bottle not found" }, { status: 404 });
        const jobId = await requeueBottle(db, input.bottleId, "admin");
        kick(() => runNextStep(db, jobId));
        return NextResponse.json({ jobId });
      }
    }
  }) as Promise<NextResponse>;
}
