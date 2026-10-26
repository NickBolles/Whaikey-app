import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { runBatch, BATCH_TIERS, CHUNK_MS } from "@/lib/enrich/batch";
import { kick } from "@/lib/enrich/kick";
import { enrichLive } from "@/lib/enrich/providers";
import { reportingErrors } from "@/lib/observability/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Chunks per day the schedule may chain (each is one invocation). */
const MAX_CHAIN = 12;

/**
 * GET /api/cron/enrich — the daily scheduled enrichment (vercel.json; Hobby
 * crons run once a day). One chunk per invocation (src/lib/enrich/batch.ts);
 * when a chunk stops for time rather than for budget, pause or lack of work,
 * it calls itself for the next one, up to MAX_CHAIN. The daily $ cap is the
 * real limit — every model call checks it first.
 *
 * Same posture as `/api/cron/sweep`: no CRON_SECRET, or the wrong one, is 404.
 * Inert (200, nothing run) until ENRICH_ENABLED and a provider key are set.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return reportingErrors("cron/enrich", async () => {
    if (!enrichLive()) return NextResponse.json({ ok: true, skipped: "enrichment not enabled" });
    const url = new URL(request.url);
    const chain = Math.max(0, Number.parseInt(url.searchParams.get("chain") ?? "0", 10) || 0);
    const result = await runBatch(getDb(), { trigger: "cron", tiers: [...BATCH_TIERS], budgetMs: CHUNK_MS });
    const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;
    if (result.stopReason === "deadline" && chain + 1 < MAX_CHAIN && host) {
      // The next chunk is its own invocation with its own 60 s.
      kick(() =>
        fetch(`https://${host}/api/cron/enrich?chain=${chain + 1}`, {
          headers: { authorization: `Bearer ${secret}` },
          signal: AbortSignal.timeout(5_000),
        }).catch(() => undefined),
      );
    }
    return NextResponse.json({ ok: true, chain, ...result });
  });
}
