import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "@/db";
import * as schema from "@/db/schema";

import { MAX_TAGS_PER_POUR, normalizeTags, tagKey } from "@/lib/tags-client";

export { MAX_TAG_LENGTH, MAX_TAGS_PER_POUR, cleanTag, normalizeTags, tagKey } from "@/lib/tags-client";

export const tagsInputSchema = z.array(z.string().max(100)).max(MAX_TAGS_PER_POUR * 2);

/**
 * Replace the tags on one of the user's pours. Callers own the pour check
 * (logPour has just inserted it). Tags are created on first use and keep the
 * spelling they were first given.
 */
export async function setPourTags(db: DB, userId: string, pourId: string, raw: readonly string[]): Promise<string[]> {
  const names = normalizeTags(raw);
  await db.delete(schema.pourTags).where(and(eq(schema.pourTags.pourId, pourId), eq(schema.pourTags.userId, userId)));
  if (names.length === 0) return [];
  await db
    .insert(schema.tags)
    .values(names.map((name) => ({ id: crypto.randomUUID(), userId, name, key: tagKey(name) })))
    .onConflictDoNothing({ target: [schema.tags.userId, schema.tags.key] });
  const rows = await db
    .select({ id: schema.tags.id, name: schema.tags.name, key: schema.tags.key })
    .from(schema.tags)
    .where(and(eq(schema.tags.userId, userId), inArray(schema.tags.key, names.map(tagKey))));
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const ordered = names.map((n) => byKey.get(tagKey(n))).filter((r): r is NonNullable<typeof r> => Boolean(r));
  await db
    .insert(schema.pourTags)
    .values(ordered.map((t) => ({ pourId, tagId: t.id, userId })))
    .onConflictDoNothing();
  return ordered.map((t) => t.name);
}

export interface TagSuggestion {
  name: string;
  uses: number;
}

/** The user's own tags, most used first, then most recently used. Never anyone else's. */
export async function listTagSuggestions(db: DB, userId: string, limit = 12): Promise<TagSuggestion[]> {
  const uses = sql<number>`count(${schema.pourTags.pourId})`;
  const lastUsed = sql`max(${schema.pourTags.createdAt})`;
  const rows = await db
    .select({ name: schema.tags.name, uses })
    .from(schema.tags)
    .leftJoin(schema.pourTags, eq(schema.pourTags.tagId, schema.tags.id))
    .where(eq(schema.tags.userId, userId))
    .groupBy(schema.tags.id, schema.tags.name)
    .orderBy(desc(uses), sql`${lastUsed} desc nulls last`, schema.tags.name)
    .limit(Math.min(Math.max(limit, 1), 50));
  return rows.map((r) => ({ name: r.name, uses: Number(r.uses) }));
}

/** pourId → tag names for the user's own pours (others' pours yield nothing). */
export async function tagsForPours(db: DB, userId: string, pourIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (pourIds.length === 0) return out;
  const rows = await db
    .select({ pourId: schema.pourTags.pourId, name: schema.tags.name })
    .from(schema.pourTags)
    .innerJoin(schema.tags, eq(schema.tags.id, schema.pourTags.tagId))
    .where(and(eq(schema.pourTags.userId, userId), inArray(schema.pourTags.pourId, [...pourIds])))
    .orderBy(schema.pourTags.createdAt, schema.tags.name);
  for (const r of rows) {
    const list = out.get(r.pourId) ?? [];
    list.push(r.name);
    out.set(r.pourId, list);
  }
  return out;
}
