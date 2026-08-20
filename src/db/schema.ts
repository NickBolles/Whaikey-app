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
 * preference weight; `sampleSize` is the number of pours that carried a usable
 * flavor signal, rated or not (the rated-only count lives on the computed
 * `PalateProfileResult.ratedSampleSize`, which is what evidence floors use). Read
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
    /**
     * Where it was made. Always set for seeded bottles, including blends and
     * sourced bottlings that have no single distillery to inherit it from —
     * which is why it lives here rather than being read through `distilleryId`.
     */
    country: text("country"),
    /**
     * Sub-national origin only — a Scotch region, a US state, a Japanese
     * prefecture — and null whenever there isn't one. Never a country: a
     * blended Scotch is `country: "Scotland", region: null`, not the other way
     * around, so anything counting regions can count this column directly.
     */
    region: text("region"),
    ageYears: integer("age_years"),
    abv: doublePrecision("abv"),
    caskTypes: jsonb("cask_types").$type<string[]>(),
    mashBill: text("mash_bill"),
    msrp: doublePrecision("msrp"),
    avgPrice: doublePrecision("avg_price"),
    description: text("description"),
    flavorProfile: jsonb("flavor_profile").$type<Record<string, number>>(),
    /** Published/producer tasting descriptors, keyed by canonical leaf id (1-3). */
    producerFlavorTags: jsonb("producer_flavor_tags").$type<Record<string, number>>(),
    /** Attribution required before a producer descriptor can be shown as published. */
    producerFlavorSourceUrl: text("producer_flavor_source_url"),
    producerFlavorSourceLabel: text("producer_flavor_source_label"),
    producerFlavorRetrievedAt: timestamp("producer_flavor_retrieved_at", { withTimezone: true, mode: "date" }),
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

// "verified": a GTIN read off a cited retail product during source-backed
// catalog verification (src/lib/ingest/verify-sold.ts) — distinct from a bulk
// "seed"/"iowa" import or a first-party "user" confirmation.
export const UPC_SOURCES = ["seed", "user", "iowa", "bc", "verified"] as const;
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

/**
 * Published critic reviews on file for a bottle — the second half of the
 * comparison screen's "Professional" reference (the producer's own note lives
 * on `bottles.producerFlavorTags`). Like producer claims, a critic note is
 * only displayable with source attribution, and it is one opinion, never an
 * answer key. `score` and `scoreScale` are shown verbatim ("91", "/100") —
 * critic scales differ and we never convert between them.
 */
export const criticNotes = pgTable(
  "critic_notes",
  {
    id: id(),
    bottleId: text("bottle_id")
      .notNull()
      .references(() => bottles.id, { onDelete: "cascade" }),
    publication: text("publication").notNull(),
    score: text("score"),
    scoreScale: text("score_scale"),
    note: text("note").notNull(),
    /** Canonical leaf-id tags (1-3) extracted from the note, for agreement bars. */
    flavorTags: jsonb("flavor_tags").$type<Record<string, number>>(),
    sourceUrl: text("source_url").notNull(),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (t) => [index("critic_notes_bottle_idx").on(t.bottleId)],
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

/**
 * Per-pour social visibility (docs/SOCIAL.md §8). "private" is the immovable
 * default; no system action ever raises the visibility of existing data —
 * only the owner can, explicitly. "friends" = mutual follows; "followers" =
 * anyone with an accepted follow; "public" = any signed-in viewer via social
 * surfaces (share links remain a separate bearer-token mechanism).
 */
export const POUR_VISIBILITIES = ["private", "friends", "followers", "public"] as const;
export type PourVisibility = (typeof POUR_VISIBILITIES)[number];

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
    visibility: text("visibility").$type<PourVisibility>().notNull().default("private"),
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

/**
 * An opt-in, bearer-style public link for exactly one personal pour and its
 * note. Pours remain private unless their owner creates this row; deleting a
 * pour automatically revokes its link.
 */
export const pourShares = pgTable(
  "pour_shares",
  {
    id: id(),
    pourId: text("pour_id")
      .notNull()
      .unique()
      .references(() => pours.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    code: text("code").notNull().unique(),
    /** An opt-in share-only place label; never inferred from a device location. */
    locationLabel: text("location_label"),
    /**
     * Revocation tombstone: a non-null value makes the code 404 immediately.
     * Re-sharing the pour reuses this row with a FRESH code and clears it —
     * a revoked code must never come back to life (docs/SOCIAL.md §16.2).
     */
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (t) => [index("pour_shares_user_idx").on(t.userId)],
);

// ---------------------------------------------------------------------------
// Social (docs/SOCIAL.md — binding). Read paths NEVER select money columns
// (purchasePrice, estValue, msrp/avgPrice aggregates of a user's own shelf);
// social reads go through explicit projections in src/lib/social.ts that pick
// columns individually, mirroring getPublicPourShare().
// ---------------------------------------------------------------------------

/**
 * Social identity, created lazily at the user's first social action — never at
 * signup. The profile IS the palate card (docs/SOCIAL.md §7.1): social
 * surfaces render palate data, never spend, value, or pour counts.
 */
export const userProfiles = pgTable("user_profiles", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  /** Lowercase [a-z0-9_]{3,20}; uniqueness is case-insensitive by normalizing on write. */
  handle: text("handle").notNull().unique(),
  displayName: text("display_name").notNull(),
  avatarUrl: text("avatar_url"),
  bio: text("bio"),
  homeRegion: text("home_region"),
  /** Public profiles are viewable by any signed-in user; private ones only by accepted followers (and always by their owner). */
  isPublic: boolean("is_public").notNull().default(false),
  /** When false the profile is reachable only by exact handle, never suggested. */
  discoverable: boolean("discoverable").notNull().default(true),
  /**
   * The US-11 "step back" switch: false hides every social surface (profile,
   * feed presence, friend notes) without deleting anything. Reversible.
   */
  socialEnabled: boolean("social_enabled").notNull().default(true),
  /**
   * Phone discovery (docs/SOCIAL.md §7.2, D8 as amended): the raw number is
   * NEVER stored — only an HMAC (keyed by a server secret) for exact-match
   * lookup, plus the last two digits so the owner can recognize which number
   * they registered. Discovery is double-opt-in: the owner must both set a
   * number and flip phoneDiscoverable (default OFF). Contact-book import
   * remains banned; this is single-number exact lookup only.
   */
  phoneHash: text("phone_hash").unique(),
  phoneLast2: text("phone_last2"),
  phoneDiscoverable: boolean("phone_discoverable").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * One row per phone lookup, kept solely to rate-limit them durably — an
 * unthrottled endpoint would let an account iterate numbers and map who is
 * on the app. Only the requester is recorded; never the number queried.
 */
export const phoneLookups = pgTable(
  "phone_lookups",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("phone_lookups_user_idx").on(t.userId),
    // The retention sweep (recordPhoneProbe) deletes by age across all users;
    // without this index every probe would seq-scan the whole table.
    index("phone_lookups_created_at_idx").on(t.createdAt),
  ],
);

export const FOLLOW_STATES = ["pending", "accepted"] as const;
export type FollowState = (typeof FOLLOW_STATES)[number];

/**
 * Asymmetric follow graph (docs/SOCIAL.md D1). Mutual accepted follows derive
 * "friends"; follows of private profiles start as "pending" requests.
 */
export const follows = pgTable(
  "follows",
  {
    id: id(),
    followerId: text("follower_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    followeeId: text("followee_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    state: text("state").$type<FollowState>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("follows_follower_followee_uq").on(t.followerId, t.followeeId),
    index("follows_followee_idx").on(t.followeeId),
  ],
);

/**
 * Checked on EVERY social read path, in both directions — blocked users are
 * mutually invisible everywhere, immediately (docs/SOCIAL.md §11). Blocking
 * also deletes any follow rows between the pair.
 */
export const blocks = pgTable(
  "blocks",
  {
    id: id(),
    blockerId: text("blocker_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    blockedId: text("blocked_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("blocks_blocker_blocked_uq").on(t.blockerId, t.blockedId),
    index("blocks_blocked_idx").on(t.blockedId),
  ],
);

/**
 * Per-user social preferences. `defaultPourVisibility` seeds the pour sheet's
 * selector and ships as "private" (docs/SOCIAL.md D2); changing it never
 * touches existing pours.
 */
export const userSocialPrefs = pgTable("user_social_prefs", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  defaultPourVisibility: text("default_pour_visibility").$type<PourVisibility>().notNull().default("private"),
  /** Whether others may comment on this user's visible notes. */
  allowComments: boolean("allow_comments").notNull().default(true),
  notifyPrefs: jsonb("notify_prefs").$type<Record<string, boolean>>(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const REACTION_KINDS = ["cheers"] as const;
export type ReactionKind = (typeof REACTION_KINDS)[number];

/**
 * One-tap positive-only reactions on a visible pour/note (docs/SOCIAL.md
 * §7.5). Counts render on the object only — never aggregated into any
 * person-level score, rank, or leaderboard (§3.3).
 */
export const reactions = pgTable(
  "reactions",
  {
    id: id(),
    pourId: text("pour_id")
      .notNull()
      .references(() => pours.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").$type<ReactionKind>().notNull().default("cheers"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("reactions_pour_user_kind_uq").on(t.pourId, t.userId, t.kind),
    index("reactions_pour_idx").on(t.pourId),
  ],
);

/**
 * Threaded comments under a visible note (docs/SOCIAL.md US-12). Soft delete
 * via deletedAt (body is blanked on delete); replies keep rendering under a
 * deleted parent tombstone. Plain text only, escaped on render.
 */
export const comments = pgTable(
  "comments",
  {
    id: id(),
    pourId: text("pour_id")
      .notNull()
      .references(() => pours.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    parentId: text("parent_id"),
    body: text("body").notNull(),
    createdAt: createdAt(),
    editedAt: timestamp("edited_at", { withTimezone: true, mode: "date" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [index("comments_pour_idx").on(t.pourId)],
);

export const REPORT_STATES = ["open", "resolved", "dismissed"] as const;
export type ReportState = (typeof REPORT_STATES)[number];
export const REPORT_SUBJECT_TYPES = ["comment", "pour", "profile"] as const;
export type ReportSubjectType = (typeof REPORT_SUBJECT_TYPES)[number];

/**
 * Abuse reports (docs/SOCIAL.md §11). Deliberately polymorphic and without a
 * subject FK so a report survives the reported content's deletion; the queue
 * UI comes later — this is the durable record.
 */
export const reports = pgTable(
  "reports",
  {
    id: id(),
    subjectType: text("subject_type").$type<ReportSubjectType>().notNull(),
    subjectId: text("subject_id").notNull(),
    reporterId: text("reporter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    state: text("state").$type<ReportState>().notNull().default("open"),
    createdAt: createdAt(),
  },
  (t) => [index("reports_state_idx").on(t.state)],
);

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

/** A short, durable lease so only one app instance generates a bottle's cache. */
export const pairingGenerationLocks = pgTable("pairing_generation_locks", {
  bottleId: text("bottle_id")
    .primaryKey()
    .references(() => bottles.id, { onDelete: "cascade" }),
  token: text("token").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
});

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

/** Durable per-user counters for AI request rate limits. */
export const aiRateLimits = pgTable(
  "ai_rate_limits",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    window: text("window").$type<"hour" | "day">().notNull(),
    windowStart: timestamp("window_start", { withTimezone: true, mode: "date" }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [uniqueIndex("ai_rate_limits_user_window_start_uq").on(t.userId, t.window, t.windowStart)],
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

/**
 * Auditable provenance for source-backed catalog verification
 * (src/lib/ingest/verify-sold.ts). Each row is one cited retail product page
 * that evidenced an imported COLA label is a bottle actually offered for sale.
 * Persisted BEFORE a bottle is promoted imported → verified, so every
 * promotion is traceable to at least one URL + retrieval timestamp. Retailer
 * SKUs are captured here as source-specific context, never as canonical bottle
 * fields.
 */
export const bottleVerifications = pgTable(
  "bottle_verifications",
  {
    id: id(),
    bottleId: text("bottle_id")
      .notNull()
      .references(() => bottles.id, { onDelete: "cascade" }),
    /** The cited product URL the evidence was read from. */
    url: text("url").notNull(),
    /** Retailer/source label as reported alongside the URL, e.g. "Total Wine". */
    label: text("label"),
    /** Source-specific retailer SKU, if any — NOT a canonical bottle field. */
    retailerSku: text("retailer_sku"),
    /** When the model retrieved the cited page. */
    retrievedAt: timestamp("retrieved_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("bottle_verifications_bottle_idx").on(t.bottleId),
    uniqueIndex("bottle_verifications_bottle_url_uq").on(t.bottleId, t.url),
  ],
);

// ---------------------------------------------------------------------------
// Catalog verification queue (docs/DATA_SOURCES.md; src/lib/ingest/verification-queue.ts)
//
// Durable, subscription-only bulk verification of imported ("imported" status)
// bottles, replacing ad hoc `status=imported` batch selection. A bottle's
// catalog state stays on `bottles.status`; these tables track the *queue
// mechanics* around verifying it (work item lifecycle, run configuration, and
// an auditable attempt ledger), and are never themselves read as catalog
// truth. Queue finalization never mutates `bottles` directly.
// ---------------------------------------------------------------------------

export const VERIFICATION_RUN_MODES = ["dry_run", "apply"] as const;
export type VerificationRunMode = (typeof VERIFICATION_RUN_MODES)[number];

/**
 * "created": row inserted, nothing done yet.
 * "snapshotting"/"ready": queue population in progress / done for this run.
 * "completed": a dry run finished (nothing durable was queued).
 * "failed"/"cancelled": operator or error terminated the run.
 */
export const VERIFICATION_RUN_STATUSES = [
  "created",
  "snapshotting",
  "ready",
  "completed",
  "failed",
  "cancelled",
] as const;
export type VerificationRunStatus = (typeof VERIFICATION_RUN_STATUSES)[number];

/**
 * "queued"/"retry_wait": eligible for claim once `next_eligible_at` passes.
 * "leased": claimed by a worker, tracked via the lease_* columns.
 * "verified"/"not_evidenced"/"failed_terminal"/"cancelled": durable terminal
 * states — no longer selected for claim, regardless of `bottles.status`.
 */
export const VERIFICATION_WORK_STATUSES = [
  "queued",
  "leased",
  "verified",
  "not_evidenced",
  "retry_wait",
  "failed_terminal",
  "cancelled",
] as const;
export type VerificationWorkStatus = (typeof VERIFICATION_WORK_STATUSES)[number];

export const VERIFICATION_ATTEMPT_OUTCOMES = ["verified", "not_evidenced", "retry", "error"] as const;
export type VerificationAttemptOutcome = (typeof VERIFICATION_ATTEMPT_OUTCOMES)[number];

/**
 * One controller invocation's configuration and lifecycle. `requestedModel`
 * is the raw operator-supplied alias (e.g. "sonnet"); `resolvedModel` is the
 * pinned concrete model id it resolved to (resolveModel() in
 * verification-queue.ts) — both are kept so a resumed run can refuse a
 * conflicting `--model` instead of silently drifting mid-run.
 */
export const catalogVerificationRuns = pgTable(
  "catalog_verification_runs",
  {
    id: id(),
    mode: text("mode").$type<VerificationRunMode>().notNull(),
    status: text("status").$type<VerificationRunStatus>().notNull().default("created"),
    requestedModel: text("requested_model").notNull(),
    resolvedModel: text("resolved_model").notNull(),
    workers: integer("workers").notNull(),
    batchSize: integer("batch_size").notNull(),
    limit: integer("limit_count").notNull(),
    partitions: integer("partitions").notNull().default(1),
    config: jsonb("config").$type<Record<string, unknown>>(),
    /** Snapshot/attempt/lease counters, refreshed on every --report. */
    summary: jsonb("summary").$type<Record<string, unknown>>(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("catalog_verification_runs_status_idx").on(t.status)],
);

/**
 * One durable queue slot per candidate bottle (bottleId is the PK — a bottle
 * enters the queue at most once across every run, ever). This is what makes a
 * "not_evidenced" outcome durable: the row moves to a terminal status and is
 * never re-selected by claimWork, even though `bottles.status` stays
 * "imported" and a naive `status=imported` scan would keep finding it.
 */
export const catalogVerificationWork = pgTable(
  "catalog_verification_work",
  {
    bottleId: text("bottle_id")
      .primaryKey()
      .references(() => bottles.id, { onDelete: "cascade" }),
    status: text("status").$type<VerificationWorkStatus>().notNull().default("queued"),
    /** Ascending — lower claims first. See computeCandidatePriority(). */
    priority: integer("priority").notNull(),
    /** sha256 of the candidate's identity+facts at snapshot time (change detection). */
    fingerprint: text("fingerprint").notNull(),
    reasonCodes: jsonb("reason_codes").$type<string[]>().notNull().default([]),
    attempts: integer("attempts").notNull().default(0),
    /** Claimable once <= now; used for both initial queueing and retry backoff. */
    nextEligibleAt: timestamp("next_eligible_at", { withTimezone: true, mode: "date" })
      .$defaultFn(() => new Date())
      .notNull(),
    leaseToken: text("lease_token"),
    leaseWorker: text("lease_worker"),
    leaseRunId: text("lease_run_id").references(() => catalogVerificationRuns.id, { onDelete: "set null" }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "date" }),
    lastOutcome: text("last_outcome").$type<VerificationAttemptOutcome>(),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("catalog_verification_work_claim_idx").on(t.status, t.priority, t.nextEligibleAt),
    index("catalog_verification_work_lease_run_idx").on(t.leaseRunId),
  ],
);

/**
 * Append-only attempt ledger, kept even after a work row's lease is released
 * — it's the only durable link back to which run touched a bottle, since
 * catalog_verification_work.lease_run_id is cleared on finalize.
 */
export const catalogVerificationAttempts = pgTable(
  "catalog_verification_attempts",
  {
    id: id(),
    runId: text("run_id")
      .notNull()
      .references(() => catalogVerificationRuns.id, { onDelete: "cascade" }),
    bottleId: text("bottle_id")
      .notNull()
      .references(() => bottles.id, { onDelete: "cascade" }),
    leaseToken: text("lease_token").notNull(),
    worker: text("worker").notNull(),
    partition: integer("partition").notNull(),
    inputSnapshot: jsonb("input_snapshot").$type<Record<string, unknown>>().notNull(),
    outcome: text("outcome").$type<VerificationAttemptOutcome>().notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>(),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [
    index("catalog_verification_attempts_run_idx").on(t.runId),
    index("catalog_verification_attempts_bottle_idx").on(t.bottleId),
  ],
);

// ---------------------------------------------------------------------------
// Native app
// ---------------------------------------------------------------------------

/**
 * Single-use codes that hand a session from the system browser into the app's
 * WebView (docs/NATIVE_APP.md §2.3). Google refuses OAuth inside embedded
 * WebViews, so sign-in runs in the real browser — but that browser's cookie jar
 * is not the WebView's, so the resulting session has to be carried across.
 *
 * `codeHash` is a SHA-256 of the code, never the code itself: these rows are
 * short-lived bearer credentials, and a database leak must not yield usable
 * ones. `sessionCookie` holds the raw signed cookie value so the exchange can
 * reproduce it verbatim rather than minting a second session.
 */
export const nativeAuthCodes = pgTable(
  "native_auth_codes",
  {
    id: id(),
    codeHash: text("code_hash").notNull().unique(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    sessionCookieName: text("session_cookie_name").notNull(),
    sessionCookie: text("session_cookie").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    /** Set the moment a code is redeemed; a second attempt must find it non-null. */
    usedAt: timestamp("used_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (t) => [index("native_auth_codes_expires_idx").on(t.expiresAt)],
);

/**
 * Push notification registrations. One row per device install; the same user can
 * have several, and a token can migrate between users on a shared device, so
 * `token` is unique on its own and re-registration reassigns it.
 */
export const pushDevices = pgTable(
  "push_devices",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    platform: text("platform").$type<"ios" | "android">().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("push_devices_user_idx").on(t.userId)],
);

export type NativeAuthCode = typeof nativeAuthCodes.$inferSelect;
export type PushDevice = typeof pushDevices.$inferSelect;

export type VerificationRun = typeof catalogVerificationRuns.$inferSelect;
export type NewVerificationRun = typeof catalogVerificationRuns.$inferInsert;
export type VerificationWork = typeof catalogVerificationWork.$inferSelect;
export type NewVerificationWork = typeof catalogVerificationWork.$inferInsert;
export type VerificationAttempt = typeof catalogVerificationAttempts.$inferSelect;
export type NewVerificationAttempt = typeof catalogVerificationAttempts.$inferInsert;

export type User = typeof user.$inferSelect;
export type BottleUpc = typeof bottleUpcs.$inferSelect;
export type BottleVerification = typeof bottleVerifications.$inferSelect;
export type Distillery = typeof distilleries.$inferSelect;
export type Bottle = typeof bottles.$inferSelect;
export type NewBottle = typeof bottles.$inferInsert;
export type UserBottle = typeof userBottles.$inferSelect;
export type Pour = typeof pours.$inferSelect;
export type CriticNote = typeof criticNotes.$inferSelect;
export type TastingNote = typeof tastingNotes.$inferSelect;
export type Pairing = typeof pairings.$inferSelect;
export type ChatSession = typeof chatSessions.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type RecExplanation = typeof recExplanations.$inferSelect;
