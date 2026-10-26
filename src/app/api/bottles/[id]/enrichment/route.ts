import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getEnrichmentView, jobIsDue, runNextStep } from "@/lib/enrich/queue";
import { kick } from "@/lib/enrich/kick";
import { getSessionUser, withErrorHandling } from "@/lib/session";

export const dynamic = "force-dynamic";
/** A due step (the web step is the long one) runs in this invocation's `after()`. */
export const maxDuration = 60;

/**
 * GET /api/bottles/:id/enrichment?after=<seq> — the live "building this
 * bottle's card" feed. Polled by the bottle page while a job is open; returns
 * the job's state, events after `after`, and the fields filled so far.
 *
 * It is also what moves the job along: when the next step is due, it runs in
 * this request's `after()` — one step per invocation, so every step gets its
 * own function budget. A lease makes overlapping polls harmless.
 * Visibility is the bottle page's own (`catalogVisibleTo`): someone else's
 * pending submission is a 404.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  return withErrorHandling(async () => {
    const { id } = await ctx.params;
    const user = await getSessionUser();
    const afterRaw = Number(new URL(request.url).searchParams.get("after") ?? 0);
    const after = Number.isInteger(afterRaw) && afterRaw >= 0 ? afterRaw : 0;
    const db = getDb();
    const view = await getEnrichmentView(db, id, user?.id, after);
    if (!view) return NextResponse.json({ error: "Bottle not found" }, { status: 404 });
    if (view.job && (view.job.state === "queued" || view.job.state === "running")) {
      const due = await jobIsDue(db, id);
      if (due) kick(() => runNextStep(db, due));
    }
    return NextResponse.json(view, { headers: { "cache-control": "no-store" } });
  }) as Promise<NextResponse>;
}
