import { getDb } from "@/db";
import { withErrorHandling } from "@/lib/session";
import { findOutingSeat, outingChangeMarker, outingStamp, visibleOutingByCode } from "@/lib/outings";
import { readOutingGuestToken, resolveOuting } from "@/lib/outings/request";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Ctx = { params: Promise<{ code: string }> };

/** How often the stream looks for changes, and how long one stream lives before the browser reconnects. */
export const LIVE_TICK_MS = 1200;
export const LIVE_WINDOW_MS = 50_000;

/**
 * GET — a Server-Sent Events stream for people on an open outing. It sends
 * `stamp` events with the viewer's filtered stamp whenever something they can
 * see changes, so new bottles, ratings, notes and replies arrive within a
 * second or two instead of on the next poll. Like the stamp route it carries
 * no presence: nothing says who has the page open. The stream closes itself
 * after LIVE_WINDOW_MS (serverless time limits) and EventSource reconnects;
 * clients that can't stream fall back to polling /state.
 */
export async function GET(req: Request, ctx: Ctx) {
  return withErrorHandling(async () => {
    const { code } = await ctx.params;
    const { db, user, outing, seat } = await resolveOuting(req, code);
    if (!outing) return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "content-type": "application/json" } });
    const onTrip = !!seat || user?.id === outing.hostId;
    if (!onTrip || outing.state !== "open") {
      return new Response(JSON.stringify({ error: "not_live" }), { status: 409, headers: { "content-type": "application/json" } });
    }
    const viewerId = user?.id ?? null;
    const guestToken = readOutingGuestToken(req.headers.get("cookie"), code);
    const enc = new TextEncoder();
    const started = Date.now();
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, data: unknown) => {
          if (!closed) controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };
        const close = () => {
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };
        req.signal.addEventListener("abort", close);
        // Reconnect quickly after the window ends.
        controller.enqueue(enc.encode("retry: 1500\n\n"));
        // Read the marker before the stamp: a write that lands in between then
        // shows up as a changed marker on the next tick instead of being lost.
        let marker = await outingChangeMarker(db, outing.id).catch(() => "");
        let stamp = await outingStamp(db, outing, viewerId, seat);
        send("stamp", { stamp });
        while (!closed && Date.now() - started < LIVE_WINDOW_MS) {
          await new Promise((r) => setTimeout(r, LIVE_TICK_MS));
          if (closed) break;
          const next = await outingChangeMarker(db, outing.id).catch(() => null);
          if (next == null || next === marker) continue;
          marker = next;
          // Re-check access on every change: leaving, a new block or the host
          // ending the outing all close the stream.
          const fresh = await visibleOutingByCode(getDb(), code, viewerId).catch(() => null);
          if (!fresh) break;
          const freshSeat = await findOutingSeat(db, fresh.id, { userId: viewerId, guestToken }).catch(() => null);
          if (!freshSeat && viewerId !== fresh.hostId) break;
          const s = await outingStamp(db, fresh, viewerId, freshSeat).catch(() => null);
          if (s && s !== stamp) {
            stamp = s;
            send("stamp", { stamp });
          }
          if (fresh.state !== "open") {
            send("ended", {});
            break;
          }
        }
        close();
      },
      cancel() {
        closed = true;
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  });
}
