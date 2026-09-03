import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { readJsonWithinLimit } from "@/lib/body-limit";
import { searchBottles } from "@/lib/search";
import { isValidUpc, normalizeUpc, resolveUpc } from "@/lib/scan";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_ROWS = 300;
/**
 * 300 rows of name + UPC is a few tens of kilobytes; a megabyte is generous
 * and still bounded. Route handlers have no body limit of their own, so
 * without this the row cap was only checked after the whole body had been
 * buffered and parsed (review SEC-M1).
 */
const MAX_BODY_BYTES = 1024 * 1024;

const bodySchema = z.object({
  rows: z
    .array(
      z.object({
        name: z.string().max(300).nullish(),
        upc: z.string().max(64).nullish(),
      }),
    )
    .min(1)
    .max(MAX_ROWS),
});

export interface ImportMatchCandidate {
  id: string;
  name: string;
  distillery: string | null;
  category: string;
  via: "upc" | "name";
}

/**
 * POST /api/import/match {rows: [{name?, upc?}]} → {results: [{candidates}]}
 *
 * Resolves each spreadsheet row against the catalog: UPC first (exact,
 * community-ranked), then fuzzy name search. Read-only — the user picks or
 * skips each row before anything is committed.
 */
export async function POST(request: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();

    const body = await readJsonWithinLimit(request, MAX_BODY_BYTES);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const db = getDb();
    const results: Array<{ candidates: ImportMatchCandidate[] }> = [];
    for (const row of parsed.data.rows) {
      const candidates: ImportMatchCandidate[] = [];
      const seen = new Set<string>();

      const code = row.upc ? normalizeUpc(row.upc) : null;
      if (code && isValidUpc(code)) {
        for (const m of await resolveUpc(db, code)) {
          if (candidates.length >= 2) break;
          seen.add(m.id);
          candidates.push({
            id: m.id,
            name: m.name,
            distillery: m.distillery,
            category: m.category,
            via: "upc",
          });
        }
      }

      if (candidates.length === 0 && row.name?.trim()) {
        for (const m of await searchBottles(db, row.name, { limit: 3, viewerId: user.id })) {
          if (seen.has(m.id)) continue;
          candidates.push({
            id: m.id,
            name: m.name,
            distillery: m.distillery,
            category: m.category,
            via: "name",
          });
        }
      }

      results.push({ candidates });
    }

    return NextResponse.json({ results });
  });
}
