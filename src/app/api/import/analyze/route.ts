import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, withErrorHandling } from "@/lib/session";
import { fastModel, getAnthropic, isAiConfigured } from "@/lib/ai/client";
import { parseModelJson, textFromContent } from "@/lib/ai/json";
import { heuristicMapping, IMPORT_FIELDS, type ColumnMapping } from "@/lib/import";

export const runtime = "nodejs";
export const maxDuration = 30;

const bodySchema = z.object({
  headers: z.array(z.string()).min(1).max(64),
  sampleRows: z.array(z.array(z.string())).max(5),
});

const PROMPT_INTRO = [
  "You map spreadsheet columns from a whiskey-collection export to known fields.",
  "Return STRICT JSON only, no prose, no markdown fences — an object whose keys are",
  `exactly: ${IMPORT_FIELDS.join(", ")}.`,
  "Each value must be one of the header strings below (verbatim) or null when no column fits.",
  "- name: the bottle/whiskey name column (required if any column plausibly fits).",
  "- upc: UPC/EAN/barcode digits.",
  "- relationship: whether the row is owned / tried / wishlist.",
  "- status: sealed/open/finished.",
  "- fillLevel: how full the bottle is.",
  "- quantity: bottle count.",
  "- purchasePrice: what the user paid (NOT current market value).",
  "- purchaseDate, store, location, notes: as named.",
  "Never map the same header to two fields.",
].join("\n");

/**
 * POST /api/import/analyze {headers, sampleRows} → {mapping, source}
 *
 * Proposes a column mapping for the confirm step: AI when configured (handles
 * arbitrary/competitor export headers), name-pattern heuristics otherwise.
 * The mapping is a suggestion — the user confirms before any matching runs.
 */
export async function POST(request: Request) {
  return withErrorHandling(async () => {
    await requireUser();

    const body = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const { headers, sampleRows } = parsed.data;
    const fallback = heuristicMapping(headers);

    if (!isAiConfigured()) {
      return NextResponse.json({ mapping: fallback, source: "heuristic" });
    }

    try {
      const anthropic = getAnthropic();
      const response = await anthropic.messages.create({
        model: fastModel(),
        max_tokens: 512,
        messages: [
          {
            role: "user",
            content: [
              PROMPT_INTRO,
              `Headers: ${JSON.stringify(headers)}`,
              `Sample rows: ${JSON.stringify(sampleRows)}`,
            ].join("\n\n"),
          },
        ],
      });
      const raw = parseModelJson(textFromContent(response.content as never));
      const obj = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;

      const mapping = { ...fallback } as ColumnMapping;
      const used = new Set<number>();
      for (const field of IMPORT_FIELDS) {
        const header = obj[field];
        if (typeof header === "string") {
          const idx = headers.indexOf(header);
          mapping[field] = idx >= 0 && !used.has(idx) ? idx : null;
        } else {
          mapping[field] = null;
        }
        if (mapping[field] !== null) used.add(mapping[field]!);
      }
      // The model must not lose a name column the heuristics found.
      if (mapping.name === null && fallback.name !== null && !used.has(fallback.name)) {
        mapping.name = fallback.name;
      }
      return NextResponse.json({ mapping, source: "ai" });
    } catch {
      // Any model hiccup degrades to heuristics — import never blocks on AI.
      return NextResponse.json({ mapping: fallback, source: "heuristic" });
    }
  });
}
