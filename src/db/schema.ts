import { sqliteTable, text, integer, real, uniqueIndex, index } from "drizzle-orm/sqlite-core";

const id = () => text("id").primaryKey();
const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .$defaultFn(() => new Date())
    .notNull();
const updatedAt = () =>
  integer("updated_at", { mode: "timestamp_ms" })
    .$defaultFn(() => new Date())
    .notNull();

// ---------------------------------------------------------------------------
// Better Auth tables (standard shape expected by the drizzle adapter)
// ---------------------------------------------------------------------------

export const user = sqliteTable("user", {
  id: id(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const session = sqliteTable("session", {
  id: id(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  token: text("token").notNull().unique(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const account = sqliteTable("account", {
  id: id(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
  scope: text("scope"),
  password: text("password"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const verification = sqliteTable("verification", {
  id: id(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
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

export const distilleries = sqliteTable("distilleries", {
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
export const bottles = sqliteTable(
  "bottles",
  {
    id: id(),
    distilleryId: text("distillery_id").references(() => distilleries.id),
    name: text("name").notNull(),
    category: text("category").$type<WhiskeyCategory>().notNull(),
    region: text("region"),
    ageYears: integer("age_years"),
    abv: real("abv"),
    caskTypes: text("cask_types", { mode: "json" }).$type<string[]>(),
    mashBill: text("mash_bill"),
    msrp: real("msrp"),
    avgPrice: real("avg_price"),
    description: text("description"),
    flavorProfile: text("flavor_profile", { mode: "json" }).$type<Record<string, number>>(),
    imageUrl: text("image_url"),
    status: text("status").$type<"verified" | "user_submitted">().notNull().default("verified"),
    submittedBy: text("submitted_by").references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [index("bottles_category_idx").on(t.category), index("bottles_name_idx").on(t.name)],
);

export const bottleAliases = sqliteTable(
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

export const RELATIONSHIPS = ["own", "tried", "wishlist"] as const;
export type Relationship = (typeof RELATIONSHIPS)[number];
export const BOTTLE_STATUSES = ["sealed", "open", "finished", "sold", "traded", "gifted"] as const;
export type BottleStatus = (typeof BOTTLE_STATUSES)[number];

export const userBottles = sqliteTable(
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
    purchasePrice: real("purchase_price"),
    purchaseDate: integer("purchase_date", { mode: "timestamp_ms" }),
    store: text("store"),
    estValue: real("est_value"),
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

export const pours = sqliteTable(
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
    rating: real("rating"),
    servingStyle: text("serving_style").$type<ServingStyle>(),
    amountMl: integer("amount_ml"),
    context: text("context", { mode: "json" }).$type<{ setting?: string; companions?: string; glassware?: string }>(),
    createdAt: createdAt(),
  },
  (t) => [index("pours_user_idx").on(t.userId), index("pours_bottle_idx").on(t.bottleId)],
);

/**
 * flavorTags: JSON mapping leaf descriptor ids from the flavor wheel to
 * intensity 1-3, e.g. {"vanilla":3,"green-apple":1}.
 */
export const tastingNotes = sqliteTable("tasting_notes", {
  id: id(),
  pourId: text("pour_id")
    .notNull()
    .unique()
    .references(() => pours.id, { onDelete: "cascade" }),
  nose: text("nose"),
  palate: text("palate"),
  finish: text("finish"),
  freeform: text("freeform"),
  flavorTags: text("flavor_tags", { mode: "json" }).$type<Record<string, number>>(),
  extractedBy: text("extracted_by").$type<"user" | "ai">().notNull().default("user"),
  createdAt: createdAt(),
});

export const pairings = sqliteTable(
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

export const chatSessions = sqliteTable(
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

export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: id(),
    sessionId: text("session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    role: text("role").$type<"user" | "assistant">().notNull(),
    content: text("content").notNull(),
    toolCalls: text("tool_calls", { mode: "json" }).$type<Array<{ name: string; input: unknown; result?: unknown }>>(),
    createdAt: createdAt(),
  },
  (t) => [index("chat_messages_session_idx").on(t.sessionId)],
);

export const priceHistory = sqliteTable(
  "price_history",
  {
    id: id(),
    bottleId: text("bottle_id")
      .notNull()
      .references(() => bottles.id, { onDelete: "cascade" }),
    date: integer("date", { mode: "timestamp_ms" }).notNull(),
    price: real("price").notNull(),
    source: text("source").notNull(),
  },
  (t) => [index("price_history_bottle_idx").on(t.bottleId)],
);

export type User = typeof user.$inferSelect;
export type Distillery = typeof distilleries.$inferSelect;
export type Bottle = typeof bottles.$inferSelect;
export type NewBottle = typeof bottles.$inferInsert;
export type UserBottle = typeof userBottles.$inferSelect;
export type Pour = typeof pours.$inferSelect;
export type TastingNote = typeof tastingNotes.$inferSelect;
export type Pairing = typeof pairings.$inferSelect;
export type ChatSession = typeof chatSessions.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;
