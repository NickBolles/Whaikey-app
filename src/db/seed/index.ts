import { sql } from "drizzle-orm";
import type { DB } from "../index";
import { bottleAliases, bottles, bottleUpcs, distilleries } from "../schema";
import { SEED_BOTTLES, SEED_BOTTLE_UPCS, SEED_DISTILLERIES } from "./data";

export interface SeedResult {
  distilleries: number;
  bottles: number;
  aliases: number;
  upcs: number;
}

const CHUNK_SIZE = 50;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function aliasSlug(alias: string): string {
  return alias
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Insert-or-replace the seed catalog by stable id. Safe to run repeatedly:
 * re-running updates existing rows in place and never duplicates.
 */
export async function seedDatabase(db: DB): Promise<SeedResult> {
  for (const batch of chunk(SEED_DISTILLERIES, CHUNK_SIZE)) {
    await db
      .insert(distilleries)
      .values(
        batch.map((d) => ({
          id: d.id,
          name: d.name,
          country: d.country,
          region: d.region ?? null,
          founded: d.founded ?? null,
          description: d.description ?? null,
        })),
      )
      .onConflictDoUpdate({
        target: distilleries.id,
        set: {
          name: sql`excluded.name`,
          country: sql`excluded.country`,
          region: sql`excluded.region`,
          founded: sql`excluded.founded`,
          description: sql`excluded.description`,
        },
      });
  }

  for (const batch of chunk(SEED_BOTTLES, CHUNK_SIZE)) {
    await db
      .insert(bottles)
      .values(
        batch.map((b) => ({
          id: b.id,
          distilleryId: b.distilleryId,
          name: b.name,
          category: b.category,
          region: b.region ?? null,
          ageYears: b.ageYears,
          abv: b.abv,
          caskTypes: b.caskTypes,
          mashBill: b.mashBill ?? null,
          msrp: b.msrp,
          avgPrice: b.avgPrice,
          description: b.description,
          flavorProfile: b.flavorProfile,
          status: "verified" as const,
        })),
      )
      .onConflictDoUpdate({
        target: bottles.id,
        set: {
          distilleryId: sql`excluded.distillery_id`,
          name: sql`excluded.name`,
          category: sql`excluded.category`,
          region: sql`excluded.region`,
          ageYears: sql`excluded.age_years`,
          abv: sql`excluded.abv`,
          caskTypes: sql`excluded.cask_types`,
          mashBill: sql`excluded.mash_bill`,
          msrp: sql`excluded.msrp`,
          avgPrice: sql`excluded.avg_price`,
          description: sql`excluded.description`,
          flavorProfile: sql`excluded.flavor_profile`,
          status: sql`excluded.status`,
        },
      });
  }

  const aliasRows = SEED_BOTTLES.flatMap((b) =>
    (b.aliases ?? []).map((alias) => ({
      id: `${b.id}--${aliasSlug(alias)}`,
      bottleId: b.id,
      alias,
    })),
  );
  for (const batch of chunk(aliasRows, CHUNK_SIZE)) {
    await db
      .insert(bottleAliases)
      .values(batch)
      .onConflictDoUpdate({
        target: bottleAliases.id,
        set: {
          bottleId: sql`excluded.bottle_id`,
          alias: sql`excluded.alias`,
        },
      });
  }

  // Seed rows never overwrite user confirmations: on any conflict (same id
  // from a re-seed, or a user-confirmed row already holding this upc+bottle)
  // the existing row — and its confirmedCount — wins.
  const upcRows = Object.entries(SEED_BOTTLE_UPCS).flatMap(([bottleId, codes]) =>
    codes.map((upc) => ({
      id: `${bottleId}--upc-${upc}`,
      bottleId,
      upc,
      source: "seed" as const,
      confirmedCount: 0,
    })),
  );
  for (const batch of chunk(upcRows, CHUNK_SIZE)) {
    await db.insert(bottleUpcs).values(batch).onConflictDoNothing();
  }

  return {
    distilleries: SEED_DISTILLERIES.length,
    bottles: SEED_BOTTLES.length,
    aliases: aliasRows.length,
    upcs: upcRows.length,
  };
}
