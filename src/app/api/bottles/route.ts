import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { RELATIONSHIPS, WHISKEY_CATEGORIES } from "@/db/schema";
import { requireUser, withErrorHandling } from "@/lib/session";
import { readJsonWithinLimit } from "@/lib/body-limit";
import { upsertUserBottle } from "@/lib/bar";
import { isValidUpc, normalizeUpc } from "@/lib/scan";
import {
  DuplicateBottleError,
  findSubmissionDuplicates,
  submitBottle,
  SubmissionRateLimitedError,
} from "@/lib/catalog";

export const runtime = "nodejs";

/** A bottle record is a handful of short fields; nothing here is prose. */
const MAX_BODY_BYTES = 8 * 1024;

const bodySchema = z.object({
  name: z.string().trim().min(2).max(160),
  category: z.enum(WHISKEY_CATEGORIES),
  distillery: z.string().trim().max(120).optional(),
  country: z.string().trim().max(80).optional(),
  region: z.string().trim().max(80).optional(),
  ageYears: z.number().int().min(0).max(100).optional(),
  abv: z.number().min(0).max(100).optional(),
  msrp: z.number().min(0).max(1_000_000).optional(),
  /** The barcode that missed, when this came out of a scan. */
  upc: z.string().trim().max(64).optional(),
  source: z.enum(["scan", "search", "import", "direct"]).optional(),
  /** Add it to the shelf in the same round trip, the way /scan/confirm does. */
  relationship: z.enum(RELATIONSHIPS).optional(),
  /**
   * Set once the user has seen the near-matches and said none of them is it.
   * Without it a name that already exists comes back as a 409 with the
   * candidates, which is the dedupe prompt.
   */
  confirmNew: z.boolean().optional(),
});

/**
 * POST /api/bottles — add a bottle the catalog lacks (review PLAN-A1).
 *
 * The report's highest-severity product gap was that a scan, search or import
 * miss was terminal: 269 seeded bottles and no way to add the 270th. This is
 * that way. The bottle is written immediately and is usable immediately —
 * pour it, shelve it, note it — but it carries `status: "user_submitted"`, so
 * until a moderator promotes it, it exists for its submitter alone.
 *
 * 409 with `duplicates` when the name matches something already in the
 * catalog and the client hasn't confirmed it means to add a new one. Merging
 * duplicate bottles later is far more expensive than asking now.
 */
export async function POST(request: Request): Promise<NextResponse> {
  return withErrorHandling(async () => {
    const user = await requireUser();

    const body = await readJsonWithinLimit(request, MAX_BODY_BYTES);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.issues.map((i) => i.message) },
        { status: 400 },
      );
    }
    const input = parsed.data;

    let upc: string | undefined;
    if (input.upc != null) {
      const normalized = normalizeUpc(input.upc);
      if (!normalized || !isValidUpc(normalized)) {
        return NextResponse.json({ error: "Not a valid UPC/EAN barcode" }, { status: 400 });
      }
      upc = normalized;
    }

    const db = getDb();

    // Loose near-matches, for the "you may already have this" list. The
    // refusal is decided inside the write's lock instead (below), because two
    // identical requests can both clear a check made out here.
    const nearby = await findSubmissionDuplicates(db, user.id, input.name);

    let created;
    try {
      created = await submitBottle(db, user.id, { ...input, upc });
    } catch (err) {
      if (err instanceof DuplicateBottleError) {
        // Only an actual name collision blocks. Loose search hits are worth
        // showing and never worth refusing over — the premise of this route is
        // that the catalog is incomplete.
        return NextResponse.json(
          { error: "That bottle may already be in the catalog", duplicates: err.duplicates },
          { status: 409 },
        );
      }
      if (err instanceof SubmissionRateLimitedError) {
        return NextResponse.json(
          { error: "That's a lot of new bottles at once — try again in a bit." },
          { status: 429 },
        );
      }
      throw err;
    }

    let userBottle = null;
    if (input.relationship) {
      const result = await upsertUserBottle(db, user.id, {
        bottleId: created.bottle.id,
        relationship: input.relationship,
      });
      userBottle = result.row;
    }

    return NextResponse.json(
      {
        bottle: created.bottle,
        submissionId: created.submissionId,
        userBottle,
        /** Near-matches we found anyway, so the client can offer a merge later. */
        similar: nearby.filter((b) => b.id !== created.bottle.id),
      },
      { status: 201 },
    );
  }) as Promise<NextResponse>;
}
