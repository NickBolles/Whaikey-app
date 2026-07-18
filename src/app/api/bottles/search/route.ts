import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { WHISKEY_CATEGORIES } from "@/db/schema";
import { withErrorHandling } from "@/lib/session";
import { searchBottles } from "@/lib/search";

const paramsSchema = z.object({
  q: z.string().optional().default(""),
  category: z.enum(WHISKEY_CATEGORIES).optional(),
});

/**
 * GET /api/bottles/search?q=...&category=...
 * Public catalog search. Empty q returns popular bottles (alphabetical,
 * limit 20). Invalid category -> 400.
 * Response: { results: BottleSearchResult[] }
 */
export async function GET(req: Request): Promise<NextResponse> {
  return withErrorHandling(async () => {
    const url = new URL(req.url);
    const parsed = paramsSchema.safeParse({
      q: url.searchParams.get("q") ?? "",
      category: url.searchParams.get("category") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid query parameters", details: parsed.error.issues.map((i) => i.message) },
        { status: 400 },
      );
    }
    const { q, category } = parsed.data;
    const results = await searchBottles(getDb(), q, { category });
    return NextResponse.json({ results });
  }) as Promise<NextResponse>;
}
