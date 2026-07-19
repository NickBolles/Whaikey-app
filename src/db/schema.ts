import {
  pgTable,
  text,
  integer,
  doublePrecision,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

const id = () => text("id").primaryKey();
const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "date" })
    .$defaultFn(() => new Date())
    .notNull();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true, mode: "date" })
    .$defaultFn(() => new Date())
    .notNull();

// ---------------------------------------------------------------------------
// Better Auth tables (standard shape expected by the drizzle adapter)
// ---------------------------------------------------------------------------

/**
 * palateProfile: incrementally-accumulated flavor-preference snapshot
 * (src/lib/palate.ts). `vector` maps the 8 flavor-wheel wedge ids to a signed
 * preference weight; `sampleSize` is the number of rated pours folded in. Read
 * paths recompute from pours for freshness — this column is the running cache.
 */
export interface PalateProfile {
  vector: Record<string, number>;
  sampleSize: number;
  updatedAt: string;
}

export const user = pgTable("user", {
  id: id(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  palateProfile: jsonb("palate_profile").$type<PalateProfile>(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const session = pgTable("session", {
  id: id(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  token: text("token").notNull().unique(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const account = pgTable("account", {
  id: id(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true, mode: "date" }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true, mode: "date" }),
  scope: text("scope"),
  password: text("password"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const verification = pgTable("verification", {
  id: id(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------------
// Whiskey domain
// ---------------------------------------------------------------------------

export const WHISKEY_CATEGORIES = [
  "bourbon",
  "rye",
  "american-single-malt",
  "american-other",
  "scotch-single-malt",
  "scotch-blended",
  "irish",
  "japanese",
  "canadian",
  "world",
] as const;
export type WhiskeyCategory = (typeof WHISKEY_CATEGORIES)[number];

export const distilleries = pgTable("distilleries", {
  id: id(),
  name: text("name").notNull(),
  country: text("country").notNull(),
  region: text("region"),
  founded: integer("founded"),
  description: text("description"),
  createdAt: createdAt(),
});

/**
 * flavorProfile: JSON object mapping the 8 core flavor-wheel wedges to 0-10
 * intensity, e.g. {"fruity":6,"floral":2,"grain":3,"sweet":8,"woody":7,
 * "spicy":5,"peaty":0,"feinty":1}. Keys defined in src/lib/flavor-wheel.ts.
 */
export const bottles = pgTable(
  "bottles",
  {
    id: id(),
    distilleryId: text("distillery_id").references(() => distilleries.id),
    name: text("name").notNull(),
    category: text("category").$type<WhiskeyCategory>().notNull(),
    region: text("region"),
    ageYears: integer("age_years"),
    abv: doublePrecision("abv"),
    caskTypes: jsonb("cask_types").$type<string[]>(),
    mashBill: text("mash_bill"),
    msrp: doublePrecision("msrp"),
    avgPrice: doublePrecision("avg_price"),
    description: text("description"),
    flavorProfile: jsonb("flavor_profile").$type<Record<string, number>>(),
    imageUrl: text("image_url"),
    status: text("status")
      .$type<"verified" | "user_submitted" | "imported">()
      .notNull()
      .default("verified"),
    submittedBy: text("submitted_by").references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [index("bottles_category_idx").on(t.category), index("bottles_name_idx").on(t.name)],
);

export const bottleAliases = pgTable(
  "bottle_aliases",
  {
    id: id(),
    bottleId: text("bottle_id")
      .notNull()
      .references(() => bottles.id, { onDelete: "cascade" }),
    alias: text("alias").notNull(),
  },
  (t) => [index("bottle_aliases_bottle_idx").on(t.bottleId), index("bottle_aliases_alias_idx").on(t.alias)],
);

export const UPC_SOURCES = ["seed", "user", "iowa"] as const;
export type UpcSource = (typeof UPC_SOURCES)[number];

/**
 * UPC/EAN barcode → bottle mappings, resolved own-DB-first at scan time
 * (docs/DATA_SOURCES.md §3). The same barcode can legitimately map to more
 * than one bottle (producers reuse UPCs across proofs/batches/years), so
 * (upc, bottleId) is the unique key and resolution ranks by confirmedCount.
 * Every user confirmation increments the count — scans convert third-party
 * lookups into first-party data we keep.
 */
export const bottleUpcs = pgTable(
  "bottle_upcs",
  {
    id: id(),
    /** Normalized GTIN digits (see normalizeUpc in src/lib/scan.ts). */
    upc: text("upc").notNull(),
    bottleId: text("bottle_id")
      .notNull()
      .references(() => bottles.id, { onDelete: "cascade" }),
    source: text("source").$type<UpcSource>().notNull().default("user"),
    confirmedCount: integer("confirmed_count").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("bottle_upcs_upc_bottle_uq").on(t.upc, t.bottleId),
    index("bottle_upcs_upc_idx").on(t.upc),
  ],
);

export const RELATIONSHIPS = ["own", "tried", "wishlist"] as const;
export type Relationship = (typeof RELATIONSHIPS)[number];
export const BOTTLE_STATUSES = ["sealed", "open", "finished", "sold", "traded", "gifted"] as const;
export type BottleStatus = (typeof BOTTLE_STATUSES)[number];

export const userBottles = pgTable(
  "user_bottles",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    bottleId: text("bottle_id")
      .notNull()
      .references(() => bottles.id, { onDelete: "cascade" }),
    relationship: text("relationship").$type<Relationship>().notNull(),
    status: text("status").$type<BottleStatus>(),
    /** 0-100, only meaningful when status is "open" */
    fillLevel: integer("fill_level"),
    quantity: integer("quantity").notNull().default(1),
    purchasePrice: doublePrecision("purchase_price"),
    purchaseDate: timestamp("purchase_date", { withTimezone: true, mode: "date" }),
    store: text("store"),
    estValue: doublePrecision("est_value"),
    location: text("location"),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("user_bottles_user_bottle_uq").on(t.userId, t.bottleId),
    index("user_bottles_user_idx").on(t.userId),
  ],
);

export const SERVING_STYLES = ["neat", "rocks", "splash", "cocktail", "highball"] as const;
export type ServingStyle = (typeof SERVING_STYLES)[number];

export const pours = pgTable(
  "pours",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    bottleId: text("bottle_id")
      .notNull()
      .references(() => bottles.id, { onDelete: "cascade" }),
    userBottleId: text("user_bottle_id").references(() => userBottles.id, { onDelete: "set null" }),
    /** 0.5-5.0 in half-star steps */
    rating: doublePrecision("rating"),
    servingStyle: text("serving_style").$type<ServingStyle>(),
    amountMl: integer("amount_ml"),
    context: jsonb("context").$type<{ setting?: string; companions?: string; glassware?: string }>(),
    createdAt: createdAt(),
  },
  (t) => [index("pours_user_idx").on(t.userId), index("pours_bottle_idx").on(t.bottleId)],
);

/**
 * flavorTags: JSON mapping leaf descriptor ids from the flavor wheel to
 * intensity 1-3, e.g. {"vanilla":3,"green-apple":1}.
 */
export const tastingNotes = pgTable("tasting_notes", {
  id: id(),
  pourId: text("pour_id")
    .notNull()
    .unique()
    .references(() => pours.id, { onDelete: "cascade" }),
  nose: text("nose"),
  palate: text("palate"),
  finish: text("finish"),
  freeform: text("freeform"),
  flavorTags: jsonb("flavor_tags").$type<Record<string, number>>(),
  extractedBy: text("extracted_by").$type<"user" | "ai">().notNull().default("user"),
  createdAt: createdAt(),
});

export const pairings = pgTable(
  "pairings",
  {
    id: id(),
    bottleId: text("bottle_id")
      .notNull()
      .references(() => bottles.id, { onDelete: "cascade" }),
    pairingType: text("pairing_type").$type<"food" | "cigar" | "cocktail">().notNull(),
    suggestion: text("suggestion").notNull(),
    rationale: text("rationale"),
    source: text("source").$type<"ai" | "community">().notNull().default("ai"),
    createdAt: createdAt(),
  },
  (t) => [index("pairings_bottle_idx").on(t.bottleId)],
);

export const chatSessions = pgTable(
  "chat_sessions",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("chat_sessions_user_idx").on(t.userId)],
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: id(),
    sessionId: text("session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    role: text("role").$type<"user" | "assistant">().notNull(),
    content: text("content").notNull(),
    toolCalls: jsonb("tool_calls").$type<Array<{ name: string; input: unknown; result?: unknown }>>(),
    createdAt: createdAt(),
  },
  (t) => [index("chat_messages_session_idx").on(t.sessionId)],
);

export const REC_MODES = ["discovery", "tonight"] as const;
export type RecMode = (typeof REC_MODES)[number];

/**
 * Cached one-line recommendation explanations, keyed by (user, bottle, mode).
 * Populated by the AI gateway when a key is configured; recommendations fall
 * back to a deterministic reason when the cache is empty, so the rail always
 * renders. Grounded in the user's own pours at generation time.
 */
export const recExplanations = pgTable(
  "rec_explanations",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    bottleId: text("bottle_id")
      .notNull()
      .references(() => bottles.id, { onDelete: "cascade" }),
    mode: text("mode").$type<RecMode>().notNull(),
    reason: text("reason").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("rec_explanations_user_bottle_mode_uq").on(t.userId, t.bottleId, t.mode),
    index("rec_explanations_user_idx").on(t.userId),
  ],
);

export const priceHistory = pgTable(
  "price_history",
  {
    id: id(),
    bottleId: text("bottle_id")
      .notNull()
      .references(() => bottles.id, { onDelete: "cascade" }),
    date: timestamp("date", { withTimezone: true, mode: "date" }).notNull(),
    price: doublePrecision("price").notNull(),
    source: text("source").notNull(),
  },
  (t) => [index("price_history_bottle_idx").on(t.bottleId)],
);

export type User = typeof user.$inferSelect;
export type BottleUpc = typeof bottleUpcs.$inferSelect;
export type Distillery = typeof distilleries.$inferSelect;
export type Bottle = typeof bottles.$inferSelect;
export type NewBottle = typeof bottles.$inferInsert;
export type UserBottle = typeof userBottles.$inferSelect;
export type Pour = typeof pours.$inferSelect;
export type TastingNote = typeof tastingNotes.$inferSelect;
export type Pairing = typeof pairings.$inferSelect;
export type ChatSession = typeof chatSessions.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type RecExplanation = typeof recExplanations.$inferSelect;
