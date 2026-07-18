import { randomUUID } from "node:crypto";
import { z } from "zod";
import { and, avg, count, desc, eq, like, or } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { getOrGeneratePairings } from "./pairings";

/**
 * Concierge tool definitions (Anthropic tool-use format) plus a DB-backed
 * executor. All executors are user-scoped where relevant and never throw into
 * the agentic loop — validation failures and unknown ids return {error}.
 */

export const TOOL_DEFINITIONS: Anthropic.Messages.Tool[] = [
  {
    name: "search_bottles",
    description:
      "Search the whiskey catalog by name or known alias/nickname. Call this when the user mentions a bottle by name and you need its id, or to find bottles matching a style. Returns up to 10 matches.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Bottle name, brand, or nickname to search for" },
        category: {
          type: "string",
          enum: [...schema.WHISKEY_CATEGORIES],
          description: "Optional category filter",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_bottle_details",
    description:
      "Get full details for one bottle: specs, distillery, flavor profile, and the community average rating. Call this before making claims about a specific bottle.",
    input_schema: {
      type: "object",
      properties: {
        bottleId: { type: "string", description: "The bottle id (from search_bottles or the user's bar)" },
      },
      required: ["bottleId"],
    },
  },
  {
    name: "get_my_bar",
    description:
      "List the bottles in the user's bar. Call this for questions about what the user owns, has tried, or wishes for. Defaults to owned bottles.",
    input_schema: {
      type: "object",
      properties: {
        relationship: {
          type: "string",
          enum: [...schema.RELATIONSHIPS],
          description: 'Filter: "own" (default), "tried", or "wishlist"',
        },
      },
      required: [],
    },
  },
  {
    name: "get_pour_history",
    description:
      "Get the user's recent pours with ratings and tasting-note snippets, newest first. Call this for questions about what the user has been drinking or how they rated something.",
    input_schema: {
      type: "object",
      properties: {
        bottleId: { type: "string", description: "Optional: only pours of this bottle" },
        limit: { type: "integer", description: "Max pours to return (default 10, max 50)" },
      },
      required: [],
    },
  },
  {
    name: "get_tasting_notes",
    description:
      "Get the user's full tasting notes (nose/palate/finish and flavor tags) for one bottle. Call this when discussing how a bottle tasted to the user.",
    input_schema: {
      type: "object",
      properties: {
        bottleId: { type: "string", description: "The bottle id" },
      },
      required: ["bottleId"],
    },
  },
  {
    name: "add_to_wishlist",
    description:
      "WRITE action: add a bottle to the user's wishlist. Only call this when the user clearly asks to save/wishlist a bottle. After calling, confirm in text exactly what was added.",
    input_schema: {
      type: "object",
      properties: {
        bottleId: { type: "string", description: "The bottle id to wishlist" },
      },
      required: ["bottleId"],
    },
  },
  {
    name: "get_pairings",
    description:
      "Get food and cocktail pairing suggestions for a bottle (cached community/AI pairings). Call this when the user asks what to eat or mix with a whiskey.",
    input_schema: {
      type: "object",
      properties: {
        bottleId: { type: "string", description: "The bottle id" },
      },
      required: ["bottleId"],
    },
  },
];

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const searchBottlesInput = z.object({
  query: z.string().min(1),
  category: z.enum(schema.WHISKEY_CATEGORIES).optional(),
});
const bottleIdInput = z.object({ bottleId: z.string().min(1) });
const myBarInput = z.object({ relationship: z.enum(schema.RELATIONSHIPS).optional() });
const pourHistoryInput = z.object({
  bottleId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

// ---------------------------------------------------------------------------
// Shared LIKE search (self-contained; also used by the label-scan route)
// ---------------------------------------------------------------------------

export interface BottleSearchResult {
  id: string;
  name: string;
  category: schema.WhiskeyCategory;
  region: string | null;
  ageYears: number | null;
  abv: number | null;
  msrp: number | null;
  avgPrice: number | null;
  distillery: string | null;
}

export async function searchBottlesLike(
  db: DB,
  query: string,
  category?: schema.WhiskeyCategory,
  limit = 10,
): Promise<BottleSearchResult[]> {
  const term = `%${query.trim()}%`;
  const matchClause = or(
    like(schema.bottles.name, term),
    like(schema.bottleAliases.alias, term),
  );
  return db
    .selectDistinct({
      id: schema.bottles.id,
      name: schema.bottles.name,
      category: schema.bottles.category,
      region: schema.bottles.region,
      ageYears: schema.bottles.ageYears,
      abv: schema.bottles.abv,
      msrp: schema.bottles.msrp,
      avgPrice: schema.bottles.avgPrice,
      distillery: schema.distilleries.name,
    })
    .from(schema.bottles)
    .leftJoin(schema.bottleAliases, eq(schema.bottleAliases.bottleId, schema.bottles.id))
    .leftJoin(schema.distilleries, eq(schema.bottles.distilleryId, schema.distilleries.id))
    .where(category ? and(matchClause, eq(schema.bottles.category, category)) : matchClause)
    .limit(limit);
}

// ---------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------

type ToolError = { error: string };
const toolError = (error: string): ToolError => ({ error });

async function getBottle(db: DB, bottleId: string): Promise<schema.Bottle | null> {
  const [bottle] = await db
    .select()
    .from(schema.bottles)
    .where(eq(schema.bottles.id, bottleId))
    .limit(1);
  return bottle ?? null;
}

async function execSearchBottles(db: DB, input: z.infer<typeof searchBottlesInput>) {
  const results = await searchBottlesLike(db, input.query, input.category, 10);
  return { results };
}

async function execGetBottleDetails(db: DB, input: z.infer<typeof bottleIdInput>) {
  const bottle = await getBottle(db, input.bottleId);
  if (!bottle) return toolError(`No bottle found with id "${input.bottleId}"`);

  let distillery: schema.Distillery | null = null;
  if (bottle.distilleryId) {
    const [row] = await db
      .select()
      .from(schema.distilleries)
      .where(eq(schema.distilleries.id, bottle.distilleryId))
      .limit(1);
    distillery = row ?? null;
  }

  const [community] = await db
    .select({ avgRating: avg(schema.pours.rating), ratingCount: count(schema.pours.rating) })
    .from(schema.pours)
    .where(eq(schema.pours.bottleId, bottle.id));

  const avgRating = community?.avgRating != null ? Math.round(Number(community.avgRating) * 100) / 100 : null;
  return { bottle, distillery, communityAvgRating: avgRating, communityRatingCount: community?.ratingCount ?? 0 };
}

async function execGetMyBar(db: DB, userId: string, input: z.infer<typeof myBarInput>) {
  const relationship = input.relationship ?? "own";
  const rows = await db
    .select({
      userBottleId: schema.userBottles.id,
      bottleId: schema.userBottles.bottleId,
      bottleName: schema.bottles.name,
      category: schema.bottles.category,
      relationship: schema.userBottles.relationship,
      status: schema.userBottles.status,
      fillLevel: schema.userBottles.fillLevel,
      quantity: schema.userBottles.quantity,
      purchasePrice: schema.userBottles.purchasePrice,
      location: schema.userBottles.location,
      notes: schema.userBottles.notes,
    })
    .from(schema.userBottles)
    .innerJoin(schema.bottles, eq(schema.userBottles.bottleId, schema.bottles.id))
    .where(
      and(eq(schema.userBottles.userId, userId), eq(schema.userBottles.relationship, relationship)),
    )
    .orderBy(desc(schema.userBottles.updatedAt));
  return { relationship, bottles: rows };
}

async function execGetPourHistory(db: DB, userId: string, input: z.infer<typeof pourHistoryInput>) {
  const limit = input.limit ?? 10;
  const filters = [eq(schema.pours.userId, userId)];
  if (input.bottleId) filters.push(eq(schema.pours.bottleId, input.bottleId));

  const rows = await db
    .select({
      pourId: schema.pours.id,
      bottleId: schema.pours.bottleId,
      bottleName: schema.bottles.name,
      rating: schema.pours.rating,
      servingStyle: schema.pours.servingStyle,
      amountMl: schema.pours.amountMl,
      createdAt: schema.pours.createdAt,
      freeform: schema.tastingNotes.freeform,
      palate: schema.tastingNotes.palate,
      nose: schema.tastingNotes.nose,
    })
    .from(schema.pours)
    .innerJoin(schema.bottles, eq(schema.pours.bottleId, schema.bottles.id))
    .leftJoin(schema.tastingNotes, eq(schema.tastingNotes.pourId, schema.pours.id))
    .where(and(...filters))
    .orderBy(desc(schema.pours.createdAt))
    .limit(limit);

  const pours = rows.map((r) => {
    const note = r.freeform ?? r.palate ?? r.nose;
    return {
      pourId: r.pourId,
      bottleId: r.bottleId,
      bottleName: r.bottleName,
      rating: r.rating,
      servingStyle: r.servingStyle,
      amountMl: r.amountMl,
      pouredAt: r.createdAt,
      noteSnippet: note ? (note.length > 120 ? `${note.slice(0, 120)}…` : note) : null,
    };
  });
  return { pours };
}

async function execGetTastingNotes(db: DB, userId: string, input: z.infer<typeof bottleIdInput>) {
  const bottle = await getBottle(db, input.bottleId);
  if (!bottle) return toolError(`No bottle found with id "${input.bottleId}"`);

  const rows = await db
    .select({
      pourId: schema.pours.id,
      rating: schema.pours.rating,
      pouredAt: schema.pours.createdAt,
      nose: schema.tastingNotes.nose,
      palate: schema.tastingNotes.palate,
      finish: schema.tastingNotes.finish,
      freeform: schema.tastingNotes.freeform,
      flavorTags: schema.tastingNotes.flavorTags,
    })
    .from(schema.tastingNotes)
    .innerJoin(schema.pours, eq(schema.tastingNotes.pourId, schema.pours.id))
    .where(and(eq(schema.pours.userId, userId), eq(schema.pours.bottleId, input.bottleId)))
    .orderBy(desc(schema.pours.createdAt));
  return { bottleName: bottle.name, notes: rows };
}

async function execAddToWishlist(db: DB, userId: string, input: z.infer<typeof bottleIdInput>) {
  const bottle = await getBottle(db, input.bottleId);
  if (!bottle) return toolError(`No bottle found with id "${input.bottleId}"`);

  const [existing] = await db
    .select()
    .from(schema.userBottles)
    .where(
      and(eq(schema.userBottles.userId, userId), eq(schema.userBottles.bottleId, input.bottleId)),
    )
    .limit(1);

  if (existing) {
    return {
      status: "already_in_bar" as const,
      bottleName: bottle.name,
      relationship: existing.relationship,
    };
  }

  await db.insert(schema.userBottles).values({
    id: randomUUID(),
    userId,
    bottleId: input.bottleId,
    relationship: "wishlist",
  });
  return { status: "added_to_wishlist" as const, bottleName: bottle.name };
}

async function execGetPairings(db: DB, input: z.infer<typeof bottleIdInput>) {
  const pairings = await getOrGeneratePairings(db, input.bottleId);
  if (pairings === null) return toolError(`No bottle found with id "${input.bottleId}"`);
  return {
    pairings: pairings.map((p) => ({
      pairingType: p.pairingType,
      suggestion: p.suggestion,
      rationale: p.rationale,
    })),
  };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Execute a concierge tool against the DB, scoped to userId. Never throws for
 * bad input or unknown resources — returns {error} objects instead so the
 * agentic loop can feed the failure back to the model.
 */
export async function executeTool(
  db: DB,
  userId: string,
  name: string,
  input: unknown,
): Promise<unknown> {
  try {
    switch (name) {
      case "search_bottles": {
        const parsed = searchBottlesInput.safeParse(input);
        if (!parsed.success) return toolError(`Invalid input: ${parsed.error.message}`);
        return await execSearchBottles(db, parsed.data);
      }
      case "get_bottle_details": {
        const parsed = bottleIdInput.safeParse(input);
        if (!parsed.success) return toolError(`Invalid input: ${parsed.error.message}`);
        return await execGetBottleDetails(db, parsed.data);
      }
      case "get_my_bar": {
        const parsed = myBarInput.safeParse(input ?? {});
        if (!parsed.success) return toolError(`Invalid input: ${parsed.error.message}`);
        return await execGetMyBar(db, userId, parsed.data);
      }
      case "get_pour_history": {
        const parsed = pourHistoryInput.safeParse(input ?? {});
        if (!parsed.success) return toolError(`Invalid input: ${parsed.error.message}`);
        return await execGetPourHistory(db, userId, parsed.data);
      }
      case "get_tasting_notes": {
        const parsed = bottleIdInput.safeParse(input);
        if (!parsed.success) return toolError(`Invalid input: ${parsed.error.message}`);
        return await execGetTastingNotes(db, userId, parsed.data);
      }
      case "add_to_wishlist": {
        const parsed = bottleIdInput.safeParse(input);
        if (!parsed.success) return toolError(`Invalid input: ${parsed.error.message}`);
        return await execAddToWishlist(db, userId, parsed.data);
      }
      case "get_pairings": {
        const parsed = bottleIdInput.safeParse(input);
        if (!parsed.success) return toolError(`Invalid input: ${parsed.error.message}`);
        return await execGetPairings(db, parsed.data);
      }
      default:
        return toolError(`Unknown tool "${name}"`);
    }
  } catch (err) {
    console.error(`Tool ${name} failed:`, err);
    return toolError(`Tool "${name}" failed unexpectedly`);
  }
}
