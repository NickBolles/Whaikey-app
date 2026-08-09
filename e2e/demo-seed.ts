import { eq } from "drizzle-orm";
import type { DB } from "../src/db/index";
import * as schema from "../src/db/schema";
import { DEMO_SESSION_TOKEN, DEMO_USER_ID, SCAN_SESSION_TOKEN, SCAN_USER_ID } from "./fixtures";

const D = (iso: string) => new Date(iso);

/**
 * Deterministic demo data for visual/e2e tests: a signed-in collector with a
 * lived-in bar, pours with notes, and fixed timestamps so screenshots are
 * stable. Bottle ids reference the seed catalog (src/db/seed/data.ts).
 */
export async function seedDemoUser(db: DB): Promise<void> {
  await db.insert(schema.user).values({
    id: DEMO_USER_ID,
    name: "Jordan Rivers",
    email: "demo@whaikey.app",
    emailVerified: true,
    createdAt: D("2026-01-15T12:00:00Z"),
    updatedAt: D("2026-01-15T12:00:00Z"),
  });

  await db.insert(schema.session).values({
    id: "demo-session",
    token: DEMO_SESSION_TOKEN,
    userId: DEMO_USER_ID,
    expiresAt: D("2030-01-01T00:00:00Z"),
    createdAt: D("2026-07-01T12:00:00Z"),
    updatedAt: D("2026-07-01T12:00:00Z"),
  });

  // Empty-shelf user for mutating flows (scan e2e) — keeps Jordan's bar stable.
  await db.insert(schema.user).values({
    id: SCAN_USER_ID,
    name: "Sam Scanner",
    email: "scan@whaikey.app",
    emailVerified: true,
    createdAt: D("2026-01-15T12:00:00Z"),
    updatedAt: D("2026-01-15T12:00:00Z"),
  });
  await db.insert(schema.session).values({
    id: "scan-session",
    token: SCAN_SESSION_TOKEN,
    userId: SCAN_USER_ID,
    expiresAt: D("2030-01-01T00:00:00Z"),
    createdAt: D("2026-07-01T12:00:00Z"),
    updatedAt: D("2026-07-01T12:00:00Z"),
  });

  const ub = (
    id: string,
    bottleId: string,
    relationship: schema.Relationship,
    extra: Partial<typeof schema.userBottles.$inferInsert> = {},
  ) => ({
    id,
    userId: DEMO_USER_ID,
    bottleId,
    relationship,
    createdAt: D("2026-06-01T12:00:00Z"),
    updatedAt: D("2026-06-20T12:00:00Z"),
    ...extra,
  });

  await db.insert(schema.userBottles).values([
    ub("demo-ub-1", "eagle-rare-10", "own", {
      status: "open",
      fillLevel: 62,
      purchasePrice: 39.99,
      purchaseDate: D("2026-03-12T12:00:00Z"),
      store: "Total Wine",
    }),
    ub("demo-ub-2", "lagavulin-16", "own", {
      status: "open",
      fillLevel: 15,
      purchasePrice: 109.99,
      purchaseDate: D("2026-01-20T12:00:00Z"),
      store: "K&L",
    }),
    ub("demo-ub-3", "blantons-original", "own", {
      status: "sealed",
      fillLevel: 100,
      purchasePrice: 74.99,
      purchaseDate: D("2026-06-05T12:00:00Z"),
      store: "Local shop",
    }),
    ub("demo-ub-4", "redbreast-12", "own", {
      status: "open",
      fillLevel: 85,
      purchasePrice: 69.99,
      purchaseDate: D("2026-05-01T12:00:00Z"),
    }),
    ub("demo-ub-5", "yamazaki-12", "wishlist"),
    ub("demo-ub-6", "weller-special-reserve", "wishlist"),
    ub("demo-ub-7", "ardbeg-10", "tried"),
  ]);

  const pour = (
    id: string,
    bottleId: string,
    rating: number,
    createdAt: string,
    extra: Partial<typeof schema.pours.$inferInsert> = {},
  ) => ({
    id,
    userId: DEMO_USER_ID,
    bottleId,
    rating,
    servingStyle: "neat" as const,
    amountMl: 45,
    createdAt: D(createdAt),
    ...extra,
  });

  // Published notes for the bottles Jordan has tasted, so the flavor map's
  // Label and Compare lenses have something to draw. These are FIXTURE data on
  // an example.com source, not real distillery claims — the catalog itself
  // carries producer notes only from the enrichment pipeline, which cites a
  // real page. Attribution is required for a claim to count as published, so
  // all three columns are set together.
  const producerNotes: Array<[string, Record<string, number>]> = [
    ["eagle-rare-10", { vanilla: 3, toffee: 2, "orange-peel": 2, oak: 2, leather: 1 }],
    ["lagavulin-16", { peat: 3, campfire: 3, medicinal: 2, raisin: 2, brine: 1 }],
    ["blantons-original", { honey: 2, citrus: 2, clove: 2, oak: 2, vanilla: 2 }],
    ["redbreast-12", { raisin: 2, nutmeg: 2, honey: 2, malt: 2, cherry: 1 }],
    ["ardbeg-10", { peat: 3, campfire: 2, citrus: 2, tar: 1 }],
  ];
  for (const [bottleId, tags] of producerNotes) {
    await db
      .update(schema.bottles)
      .set({
        producerFlavorTags: tags,
        producerFlavorSourceUrl: `https://example.com/tasting-notes/${bottleId}`,
        producerFlavorSourceLabel: "Distillery tasting notes",
        producerFlavorRetrievedAt: D("2026-06-01T12:00:00Z"),
      })
      .where(eq(schema.bottles.id, bottleId));
  }

  await db.insert(schema.pours).values([
    pour("demo-pour-1", "eagle-rare-10", 4.5, "2026-07-14T20:30:00Z", { userBottleId: "demo-ub-1" }),
    pour("demo-pour-2", "lagavulin-16", 5, "2026-07-12T21:00:00Z", {
      userBottleId: "demo-ub-2",
      servingStyle: "splash",
    }),
    pour("demo-pour-3", "ardbeg-10", 3.5, "2026-07-12T19:45:00Z"),
    pour("demo-pour-4", "redbreast-12", 4, "2026-07-05T18:15:00Z", { userBottleId: "demo-ub-4" }),
    pour("demo-pour-5", "blantons-original", 4, "2026-06-28T20:10:00Z", {
      userBottleId: "demo-ub-3",
    }),
  ]);

  await db.insert(schema.tastingNotes).values([
    {
      id: "demo-note-1",
      pourId: "demo-pour-1",
      nose: "Toffee and orchard fruit, a little leather.",
      palate: "Vanilla, cherry, gentle oak spice.",
      finish: "Medium, drying oak with brown sugar.",
      flavorTags: { vanilla: 3, cherry: 2, oak: 2, "brown-sugar": 1 },
      extractedBy: "user",
      createdAt: D("2026-07-14T20:35:00Z"),
    },
    {
      id: "demo-note-2",
      pourId: "demo-pour-2",
      nose: "Campfire and brine, dried fruit underneath.",
      palate: "Peat smoke, dark chocolate, fig.",
      finish: "Long, ashy, a touch medicinal.",
      flavorTags: { campfire: 3, brine: 2, raisin: 2, chocolate: 1, medicinal: 1 },
      extractedBy: "user",
      createdAt: D("2026-07-12T21:05:00Z"),
    },
    // Jordan reaches for cinnamon where these two labels say clove and nutmeg —
    // the substitution the Compare lens is built to surface.
    {
      id: "demo-note-3",
      pourId: "demo-pour-4",
      nose: "Sherried fruit and a warm bakery note.",
      palate: "Raisin, honey, cinnamon, ripe cherry.",
      finish: "Long and rounded, gently spiced.",
      flavorTags: { raisin: 2, honey: 2, cinnamon: 1, cherry: 2 },
      extractedBy: "user",
      createdAt: D("2026-07-05T18:20:00Z"),
    },
    {
      id: "demo-note-4",
      pourId: "demo-pour-5",
      nose: "Honey and soft vanilla.",
      palate: "Vanilla, cinnamon, light oak.",
      finish: "Short, sweet, a little dusty.",
      flavorTags: { honey: 2, vanilla: 2, cinnamon: 2, oak: 1 },
      extractedBy: "user",
      createdAt: D("2026-06-28T20:15:00Z"),
    },
  ]);

  await db.insert(schema.pairings).values([
    {
      id: "demo-pairing-1",
      bottleId: "lagavulin-16",
      pairingType: "food",
      suggestion: "Grilled oysters",
      rationale: "Brine meets peat smoke — a classic Islay match.",
      source: "ai",
      createdAt: D("2026-06-01T12:00:00Z"),
    },
    {
      id: "demo-pairing-2",
      bottleId: "lagavulin-16",
      pairingType: "food",
      suggestion: "Blue cheese",
      rationale: "Bold funk stands up to the smoke and matches its sweetness.",
      source: "ai",
      createdAt: D("2026-06-01T12:00:00Z"),
    },
  ]);
}
