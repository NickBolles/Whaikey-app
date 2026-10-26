import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { cardEpoch, cardPath } from "@/lib/cards";
import { findTaster, visibleFlightByCode } from "@/lib/flights";
import { wrappedAvailable } from "@/lib/wrapped";
import { findOutingSeat, visibleOutingByCode } from "@/lib/outings";

const schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("palate") }).strict(),
  z.object({ kind: z.literal("passport") }).strict(),
  z.object({ kind: z.literal("wrapped"), year: z.number().int() }).strict(),
  z.object({ kind: z.literal("flight"), code: z.string().min(1).max(32) }).strict(),
  z.object({ kind: z.literal("outing"), code: z.string().min(1).max(32) }).strict(),
]);

/**
 * POST /api/cards { kind, … } — mint your own card URLs (story 1080×1920 and
 * link 1200×630). Only ever for yourself, or for a revealed flight you sat at.
 * 503 when the deployment has no signing secret.
 */
export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    const input = parsed.data;
    let subject = user.id;
    let extra = "";
    if (input.kind === "wrapped") {
      if (!wrappedAvailable(input.year, new Date())) return NextResponse.json({ error: "not_yet" }, { status: 404 });
      extra = String(input.year);
    }
    if (input.kind === "flight") {
      const db = getDb();
      const flight = await visibleFlightByCode(db, input.code, user.id);
      if (!flight || flight.state === "open" || !(await findTaster(db, flight.id, { userId: user.id }))) {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      // The flight's id, never its join code: a results image must not carry
      // the credential that seats someone at the table.
      subject = flight.id;
      // Rendered as the person who shared it: their blocks shape the results.
      extra = user.id;
    }
    if (input.kind === "outing") {
      const db = getDb();
      const outing = await visibleOutingByCode(db, input.code, user.id);
      if (!outing || outing.state !== "ended" || !(await findOutingSeat(db, outing.id, { userId: user.id }))) {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      // Same as a flight: the outing's id, never its join code, rendered as the sharer.
      subject = outing.id;
      extra = user.id;
    }
    const epoch = await cardEpoch(getDb(), user.id);
    const story = cardPath(input.kind, subject, extra, "story", epoch);
    const link = cardPath(input.kind, subject, extra, "link", epoch);
    if (!story || !link) return NextResponse.json({ error: "unavailable" }, { status: 503 });
    return NextResponse.json({ story, link });
  });
}
