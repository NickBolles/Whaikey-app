import {
  bigserial,
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
    /**
     * Who first added this bottle, when a user did.
     *
     * `set null` rather than the default `no action`: a verified bottle is
     * catalog data everybody's shelf points at, so it must outlive its
     * submitter's account — and with `no action` a single submission made an
     * account permanently undeletable, which is a deletion right the schema
     * quietly revokes.
     */
    submittedBy: text("submitted_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("bottles_category_idx").on(t.category), index("bottles_name_idx").on(t.name)],
);

/**
 * A bottle somebody added because the catalog lacked it (review PLAN-A1).
 *
 * The bottle row itself is real and usable the instant it is written — the
 * whole point of the submission path is that a scan/search/import miss stops
 * being a dead end — but it carries `status: "user_submitted"`, which
 * `catalogVisibleTo` keeps to its submitter until a moderator promotes it.
 * This table is the queue behind that promotion, in the same split the
 * verification queue uses: catalog state lives on `bottles.status`, review
 * state lives here.
 *
 * `distilleryText` is what the submitter typed. User input never creates a
 * `distilleries` row — the distillery is linked only on an exact name match,
 * and otherwise the typed name is parked here for whoever reviews it.
 */
export const BOTTLE_SUBMISSION_STATES = ["pending", "approved", "rejected", "duplicate"] as const;
export type BottleSubmissionState = (typeof BOTTLE_SUBMISSION_STATES)[number];

export const bottleSubmissions = pgTable(
  "bottle_submissions",
  {
    id: id(),
    bottleId: text("bottle_id")
      .notNull()
      .references(() => bottles.id, { onDelete: "cascade" }),
    submittedBy: text("submitted_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    state: text("state").$type<BottleSubmissionState>().notNull().default("pending"),
    /** The distillery name as typed, when it matched nothing we already had. */
    distilleryText: text("distillery_text"),
    /** The barcode that missed, when the submission came out of a scan. */
    upc: text("upc"),
    /** Where the submission came from, for triage: scan, search, import, direct. */
    source: text("source"),
    /**
     * The reviewer. `set null` for the same reason as `bottles.submittedBy`,
     * and safe because `state` — not this column — is what says whether a
     * submission is still pending; clearing it cannot put a decided row back
     * in the queue.
     */
    reviewedBy: text("reviewed_by").references(() => user.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: "date" }),
    /** Set when a reviewer marks this a duplicate of an existing catalog bottle. */
    duplicateOfBottleId: text("duplicate_of_bottle_id").references(() => bottles.id),
    reviewNote: text("review_note"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("bottle_submissions_bottle_uq").on(t.bottleId),
    index("bottle_submissions_state_idx").on(t.state, t.createdAt),
    index("bottle_submissions_user_idx").on(t.submittedBy, t.createdAt),
  ],
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
    /**
     * What this pour WAS, recorded when it happened (WP-19).
     *
     * Both columns exist because a metric that reads today's state to describe
     * a past event is not measuring the past. `user_bottles.relationship` moves
     * from `tried` to `own` the day somebody buys a bottle they had only
     * sampled, which retroactively reclassifies every earlier sample of it —
     * so the tried:owned ratio SOCIAL §12 says "should rise" could fall with
     * nobody drinking or logging anything. And `visibility` is rewritten in
     * bulk to `private` by `makeEverythingPrivate` and by a suspension, which
     * erases social actions that demonstrably happened — shrinking the
     * denominator of reports-per-1,000 at exactly the moment a moderation
     * problem is what the number is being asked about.
     *
     * Nullable, and read as **unknown rather than as a value**: rows written
     * before these columns existed have no honest answer, and falling back to
     * the current column would reintroduce precisely the bug they exist to
     * fix. The guardrails count only rows carrying a snapshot, which means
     * they describe the period since this shipped — the same "the instrument
     * has no readings on its first day" honesty PLAN-A5 is held to.
     */
    shelfRelationshipAtPour: text("shelf_relationship_at_pour").$type<Relationship>(),
    visibilityAtCreation: text("visibility_at_creation").$type<PourVisibility>(),
    /**
     * Client-minted idempotency key (REL-4.2). A pour is written where the
     * signal isn't, so a save whose response is lost in transit gets retried
     * from the offline queue; the same key on the retry makes the second write
     * a no-op that returns the first pour instead of double-logging and
     * double-decrementing the fill level. Null for writes that don't carry one
     * (the API, imports, seeds) — Postgres treats nulls as distinct, so the
     * unique index below only ever constrains real keys.
     */
    clientId: text("client_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("pours_user_idx").on(t.userId),
    index("pours_bottle_idx").on(t.bottleId),
    uniqueIndex("pours_user_client_idx").on(t.userId, t.clientId),
  ],
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
/**
 * The legal-age gate (PLAN.md §9.1, review PLAN-C8/PLAN-A7).
 *
 * Three documents asserted an age gate that did not exist; this is it. One
 * row per account, written once and never rewritten: an answer that fails the
 * minimum is *kept*, so "I'm 19" cannot be walked back into "I'm 22" on the
 * next screen. `eligibleOn` is the date that answer stops failing, which is
 * what lets an account come back on its birthday rather than being dead.
 *
 * The birth date is stored as a plain `YYYY-MM-DD` string, not a timestamp:
 * a birthday is a calendar fact with no time and no zone, and storing it as
 * an instant makes it shift by a day depending on where it is read.
 */
export const ageVerifications = pgTable("age_verifications", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  /** ISO `YYYY-MM-DD`, as entered. */
  birthDate: text("birth_date").notNull(),
  /** ISO 3166-1 alpha-2, whichever market the user said they are in. */
  market: text("market").notNull(),
  /** The minimum that applied when the answer was given, kept for the record. */
  minimumAge: integer("minimum_age").notNull(),
  /** True when the answer met the minimum. False rows are blocks, not retries. */
  passed: boolean("passed").notNull(),
  /** `YYYY-MM-DD` this account becomes eligible; null once it already is. */
  eligibleOn: text("eligible_on"),
  createdAt: createdAt(),
});

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
   * Set by an operator, never by the user (PLAN.md §9.4).
   *
   * Distinct from `socialEnabled`, which is the owner's own step-back switch:
   * a suspension is not theirs to reverse, and collapsing the two would let
   * anyone lift their own with one tap of a toggle they already have. Social
   * reads and writes are refused while it is set; the journal, the shelf and
   * the export are untouched, because a suspension is from the social surfaces
   * and not from someone's own records.
   */
  suspendedAt: timestamp("suspended_at", { withTimezone: true, mode: "date" }),
  /** Shown to the suspended account, so an appeal has something to answer. */
  suspendedReason: text("suspended_reason"),
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
    /**
     * Set when the reader took the cheer back.
     *
     * Soft, like `comments.deletedAt`, and for the same reason one level up:
     * a guardrail metric that reports a different number for the same past
     * week depending on when it is asked is not a measurement. Retraction used
     * to DELETE the row, so a cheer given and withdrawn inside a window left
     * nothing behind — and since cheers are the denominator of
     * `reportsPerThousandSocialActions`, erasing them silently pushed that
     * rate up. Pours got their snapshot columns (0035) for exactly this, and
     * comments were already soft-deleted; reactions were the one social action
     * still evaporating.
     *
     * Re-cheering clears this rather than inserting a second row, and keeps
     * the ORIGINAL `createdAt`: the guardrail counts a reader deciding to
     * cheer a note, not the number of times they toggled the control.
     */
    retractedAt: timestamp("retracted_at", { withTimezone: true, mode: "date" }),
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
    /** Set by whatever removed it from view — the author, or a moderation hide. */
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
    /**
     * Set when the **author** (or the pour's owner) withdrew it.
     *
     * `deletedAt` alone could not tell the two apart, and a moderation hide
     * shares that column: while a hide stood, the author had no way to delete
     * their own comment — the control was gone and the write refused — and
     * lifting the hide republished it whether or not they had wanted it gone.
     * A takedown is not supposed to take away the author's own control over
     * their words; `docs/SOCIAL.md` gives comments soft deletion and a hide is
     * not an exception to it.
     *
     * Recorded separately rather than by overwriting `deletedAt`, because the
     * lift matches that timestamp against the hide's own to avoid republishing
     * what the author removed — so it is the one value that must not move.
     */
    authorDeletedAt: timestamp("author_deleted_at", { withTimezone: true, mode: "date" }),
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
    /**
     * Who owned the reported thing when it was reported.
     *
     * The subject can be deleted — `deletePour` is a hard delete — and without
     * this the queue lost the owner along with it, taking the Suspend control
     * with it: deleting the reported pour was a way to put the account itself
     * out of reach of moderation while the report stayed open. The content
     * going away is not the account being answered for.
     */
    subjectOwnerId: text("subject_owner_id"),
    /**
     * What the reported thing said **when it was reported**.
     *
     * The queue used to render the subject's current text, which let a
     * reported user edit the abuse away before an operator opened the report:
     * the complaint then described content that no longer existed, so it could
     * neither be judged nor evidenced. Captured at report time so the operator
     * sees what the reporter saw, and the trail keeps it after the fact.
     *
     * Null on rows filed before snapshots existed; the queue says so rather
     * than showing the current text in the slot where the original belongs.
     */
    subjectSnapshot: text("subject_snapshot"),
    state: text("state").$type<ReportState>().notNull().default("open"),
    createdAt: createdAt(),
  },
  (t) => [index("reports_state_idx").on(t.state)],
);

/**
 * What an operator did, and why (PLAN.md §9.4).
 *
 * Reports were written and never read; the queue that reads them has to leave
 * its own record or the same hole reopens one level up. Append-only: rows are
 * never edited or removed, so "who hid this and when" survives the thing being
 * hidden, and an appeal has something to answer.
 */
/**
 * `unhide` is the reversal of a hide, and it exists because the hide sticks:
 * a hidden pour cannot be re-published by its owner, so an appeal upheld has
 * to be actionable by an operator rather than by asking the owner to try again.
 */
/**
 * `resolve` is the odd one: a decision that changed no state.
 *
 * Several reports about one comment is the ordinary case, and the later ones
 * are genuinely handled by the hide or the suspension already in force — the
 * queue offers "Resolve as hidden" and "Resolve as suspended" for exactly
 * that. Applying a second hide or a second suspension would overwrite a
 * timestamp that means something, so those branches change nothing; but the
 * operator still made a decision, with a reason `docs/STORYBOARD.md` §3.17
 * requires "for every action without exception". Recording it as `hide` would
 * put a rival entry in front of `isModerationHidden` and the lift's timestamp
 * match; recording it as `dismiss` would tell an appeal the complaint was
 * unfounded. It is its own thing, and it is deliberately outside every
 * hide/unhide and suspend/reinstate filter in this file.
 */
export const MODERATION_ACTIONS = [
  "hide",
  "unhide",
  "suspend",
  "reinstate",
  "dismiss",
  "resolve",
] as const;
export type ModerationActionKind = (typeof MODERATION_ACTIONS)[number];

export const moderationActions = pgTable(
  "moderation_actions",
  {
    id: id(),
    /**
     * The operator.
     *
     * Nullable only because the account can be deleted, and null means exactly
     * that: the operator's account is gone, not that nobody acted. The write
     * path always has an actor. The alternative was `no action`, which made an
     * operator undeletable the moment they touched the queue — so the only
     * ways to honour a deletion request were to erase the audit history or to
     * reassign its actor to somebody who did not decide it, and an append-only
     * trail cannot survive either. What an appeal is answered from is the
     * decision, its reason and its order; those all keep.
     */
    actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
    action: text("action").$type<ModerationActionKind>().notNull(),
    /**
     * For a `hide`: whether this action is what removed the row.
     *
     * `unhideSubject` restores a comment by matching its `deletedAt` against
     * the hide's own `createdAt`, so that it never republishes something the
     * author deliberately deleted. Two instants can be the same millisecond,
     * though — an author's delete and a hide landing right behind it — and
     * then the match succeeds on a coincidence and the lift publishes text its
     * author removed. A timestamp is not an identity; this records the fact
     * instead of inferring it.
     *
     * False when the row was already gone when the hide landed. Null on hides
     * recorded before this column existed, where the timestamp match is still
     * the best available answer.
     */
    tookDown: boolean("took_down"),
    subjectType: text("subject_type").$type<ReportSubjectType>().notNull(),
    subjectId: text("subject_id").notNull(),
    /** The report this answered, when it came from the queue. */
    reportId: text("report_id").references(() => reports.id, { onDelete: "set null" }),
    /** The operator's reasoning, in their own words. */
    note: text("note"),
    /**
     * The order decisions actually happened in.
     *
     * `createdAt` cannot answer "is this subject hidden right now": two actions
     * can share a millisecond, and a request that captured its timestamp before
     * waiting on the moderation lock commits *after* one that captured a later
     * one. Ordering by `(createdAt, id)` disambiguates the rows without
     * preserving their order, since the id is a random UUID — so a freshly
     * hidden pour could read as lifted, or a lifted one keep blocking its owner.
     *
     * The sequence is assigned at insert, inside the per-subject advisory lock
     * every write to this table takes, so for one subject it is exactly the
     * order the decisions were made in. Every current-state query orders by it.
     */
    seq: bigserial("seq", { mode: "number" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("moderation_actions_subject_idx").on(t.subjectType, t.subjectId),
    index("moderation_actions_created_idx").on(t.createdAt),
    index("moderation_actions_seq_idx").on(t.seq),
  ],
);

/**
 * In-app feedback (PLAN.md §9.7).
 *
 * A store submission needs a support route that is not a GitHub issue form,
 * and the app has none. Stored rather than mailed because there is no mailer:
 * a row an operator reads is a support channel, an email to an address nobody
 * configured is not. The app version and platform ride along because the first
 * question about any report is "which build".
 */
export const feedback = pgTable(
  "feedback",
  {
    id: id(),
    /** Null for a signed-out sender; the support page works either way. */
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    /** Optional reply address, for a signed-out sender or a different inbox. */
    contact: text("contact"),
    platform: text("platform"),
    appVersion: text("app_version"),
    handledAt: timestamp("handled_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (t) => [index("feedback_created_idx").on(t.createdAt)],
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

/**
 * Which surface spent an AI call. Required, because "AI cost" is not one
 * number: chat, pairings, extraction, scanning, enrichment and import each
 * have a different shape, and the answer worth having is which of them is
 * expensive (PLAN-A3).
 */
export const AI_FEATURES = [
  "chat",
  "pairings",
  "extract",
  "scan",
  "enrich",
  "import",
  "recommend-explain",
] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

/**
 * Tokens spent per AI call, per account (PLAN-A3: "AI cost per premium user
 * is unmeasurable").
 *
 * `ai_rate_limits` counts *requests* in a rolling window and is swept after
 * 48 hours, so it can answer "are they over their allowance" and cannot answer
 * "what did they cost". This is the second question, and it needs the token
 * counts the model reports back rather than a request tally.
 *
 * **Tokens, never dollars.** A stored dollar figure becomes a lie the moment
 * prices change, and the rate table that converts at read time can be
 * corrected where a written-down number cannot. Same rule COMPETITORS §2.7
 * applies to bottle valuations: no false precision about money.
 *
 * `userId` is nullable because not every call is on a user's behalf — catalog
 * enrichment runs on a schedule and belongs to the system. A null there is
 * "nobody asked for this", which is a different and useful row, not a missing
 * one.
 */
export const aiUsage = pgTable(
  "ai_usage",
  {
    id: id(),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    feature: text("feature").$type<AiFeature>().notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    /** Cache reads bill at a fraction of input; kept apart or the maths is wrong. */
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index("ai_usage_user_created_idx").on(t.userId, t.createdAt),
    index("ai_usage_created_idx").on(t.createdAt),
  ],
);

/**
 * The S1 share funnel — the only thing here that needs an event at all.
 *
 * PLAN-A5's finding is that the S1→S2 overlap was never measured and S2/S3
 * shipped anyway. Measuring it needs three numbers with no home in any
 * existing table: a share page being *viewed*, a comparison being *rendered*
 * on it, and a wishlist add *sourced from* it. Reads leave no trace, so
 * without these the question cannot be asked at all.
 *
 * **Almost nothing else needed an event**, which is the point. `docs/SOCIAL.md`
 * §12's guardrail metrics — pours per active user per week, the tried:owned
 * ratio, reports per 1,000 social actions, block rate, share of accounts that
 * switch social off — are all computable from `pours`, `user_bottles`,
 * `reports`, `blocks` and `user_profiles` as they already stand. They were
 * never unmeasurable; nobody had written the queries. `metrics.ts` writes
 * them. Recording those as events too would store the same consumption
 * timestamps a second time, in a table whose whole justification is that the
 * first one could not answer.
 *
 * `userId` is nullable because a share link is readable signed-out, and
 * whether the viewer was signed in **is** the S1 number — a signed-out view
 * cannot convert.
 */
export const ANALYTICS_EVENTS = [
  "share_view",
  "share_comparison_rendered",
  "share_wishlist_add",
  /**
   * The same conversion, arrived at differently: the recipient put the bottle
   * on their shelf as `own` or `tried` rather than wishing for it.
   *
   * Separate from `share_wishlist_add` because `POST /api/user-bottles` takes
   * the relationship from the caller and the funnel's field is called
   * `wishlistAddsFromShare` — so recording an "I already own this" under that
   * name was a number that said something it did not mean. Dropping those adds
   * instead would have been the other error: someone who owns the bottle after
   * following a share link is a stronger outcome than a wishlist entry, not a
   * non-event.
   */
  "share_shelf_add",
] as const;
export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[number];

export const analyticsEvents = pgTable(
  "analytics_events",
  {
    id: id(),
    name: text("name").$type<AnalyticsEventName>().notNull(),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    /**
     * The share link this is about, so the funnel can be followed end to end.
     * Deliberately the pour_shares row id and never the share CODE, which is a
     * bearer credential: a table of live codes is a table of keys.
     */
    shareId: text("share_id").references(() => pourShares.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("analytics_events_name_created_idx").on(t.name, t.createdAt),
    index("analytics_events_share_idx").on(t.shareId),
  ],
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

export const PASSPORT_FAMILIES = ["country", "region", "style"] as const;
export type PassportFamily = (typeof PASSPORT_FAMILIES)[number];

/**
 * Achieved passport badge tiers (docs/FEATURES.md §11.4). One row per
 * (user, badge, tier) the moment it is first reached — the passport's
 * permanent record. Tiers are computed from distinct bottles met as a share
 * of the catalog (src/lib/passport.ts), but the catalog grows; these rows are
 * why a user is never downgraded when their percentage slips. `achievedAt` is
 * when the tier was stamped (sync time), so the badge detail view can show a
 * history. Rows are never updated or deleted, only inserted.
 */
export const passportTiers = pgTable(
  "passport_tiers",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    family: text("family").$type<PassportFamily>().notNull(),
    value: text("value").notNull(),
    tier: integer("tier").notNull(),
    achievedAt: timestamp("achieved_at", { withTimezone: true, mode: "date" })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (t) => [
    uniqueIndex("passport_tiers_user_badge_tier_uq").on(t.userId, t.family, t.value, t.tier),
    index("passport_tiers_user_idx").on(t.userId),
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
    /** True only when this evidence changed the bottle from imported to verified. */
    promotedBottle: boolean("promoted_bottle").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index("bottle_verifications_bottle_idx").on(t.bottleId),
    uniqueIndex("bottle_verifications_bottle_url_uq").on(t.bottleId, t.url),
  ],
);

// ---------------------------------------------------------------------------
// Source-backed catalog resources
// ---------------------------------------------------------------------------

export const CATALOG_SOURCE_KINDS = ["official", "editorial", "retailer", "registry"] as const;
export type CatalogSourceKind = (typeof CATALOG_SOURCE_KINDS)[number];
export const CATALOG_FETCH_POLICIES = ["structured", "link_only"] as const;
export type CatalogFetchPolicy = (typeof CATALOG_FETCH_POLICIES)[number];
export const CATALOG_MEDIA_POLICIES = ["display_remote", "link_only", "review_required"] as const;
export type CatalogMediaPolicy = (typeof CATALOG_MEDIA_POLICIES)[number];

/** Operator-curated source registry and fetch-origin allow list. */
export const catalogSources = pgTable("catalog_sources", {
  id: id(),
  name: text("name").notNull(),
  kind: text("kind").$type<CatalogSourceKind>().notNull(),
  baseUrl: text("base_url").notNull(),
  fetchPolicy: text("fetch_policy").$type<CatalogFetchPolicy>().notNull().default("structured"),
  mediaPolicy: text("media_policy").$type<CatalogMediaPolicy>().notNull().default("review_required"),
  attribution: text("attribution"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const BOTTLE_RESOURCE_TYPES = [
  "official_product", "producer", "distillery", "review", "retailer", "registry",
] as const;
export type BottleResourceType = (typeof BOTTLE_RESOURCE_TYPES)[number];

/** One outbound, source-owned page associated with a canonical bottle. */
export const bottleResources = pgTable(
  "bottle_resources",
  {
    id: id(),
    bottleId: text("bottle_id").notNull().references(() => bottles.id, { onDelete: "cascade" }),
    sourceId: text("source_id").notNull().references(() => catalogSources.id, { onDelete: "restrict" }),
    resourceType: text("resource_type").$type<BottleResourceType>().notNull(),
    url: text("url").notNull(),
    title: text("title"),
    publisher: text("publisher"),
    contentHash: text("content_hash"),
    matchMethod: text("match_method").$type<"manifest" | "gtin" | "exact_name" | "llm_reviewed">().notNull().default("manifest"),
    confidence: doublePrecision("confidence").notNull().default(1),
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "date" }),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("bottle_resources_bottle_url_uq").on(t.bottleId, t.url),
    index("bottle_resources_bottle_idx").on(t.bottleId),
    index("bottle_resources_source_idx").on(t.sourceId),
  ],
);

export const BOTTLE_CLAIM_FIELDS = [
  "name", "brand", "description", "gtin", "sku", "abv", "ageYears", "price", "reviewScore",
] as const;
export type BottleClaimField = (typeof BOTTLE_CLAIM_FIELDS)[number];

/** Atomic source-scoped facts. Only official-product claims may fill missing canonical fields. */
export const bottleClaims = pgTable(
  "bottle_claims",
  {
    id: id(),
    bottleId: text("bottle_id").notNull().references(() => bottles.id, { onDelete: "cascade" }),
    resourceId: text("resource_id").notNull().references(() => bottleResources.id, { onDelete: "cascade" }),
    field: text("field").$type<BottleClaimField>().notNull(),
    value: jsonb("value").$type<string | number | Record<string, string>>().notNull(),
    valueHash: text("value_hash").notNull(),
    status: text("status").$type<"accepted" | "corroborating" | "conflict" | "review_required">().notNull(),
    confidence: doublePrecision("confidence").notNull().default(1),
    canonicalized: boolean("canonicalized").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("bottle_claims_resource_field_value_uq").on(t.resourceId, t.field, t.valueHash),
    index("bottle_claims_bottle_idx").on(t.bottleId),
  ],
);

export const BOTTLE_MEDIA_KINDS = ["bottle", "distillery", "label"] as const;
export type BottleMediaKind = (typeof BOTTLE_MEDIA_KINDS)[number];

/** Source-bound media reference. The app renders only `display_remote` rows. */
export const bottleMedia = pgTable(
  "bottle_media",
  {
    id: id(),
    bottleId: text("bottle_id").notNull().references(() => bottles.id, { onDelete: "cascade" }),
    resourceId: text("resource_id").notNull().references(() => bottleResources.id, { onDelete: "cascade" }),
    kind: text("kind").$type<BottleMediaKind>().notNull(),
    url: text("url").notNull(),
    alt: text("alt"),
    rights: text("rights").$type<CatalogMediaPolicy>().notNull(),
    attribution: text("attribution"),
    width: integer("width"),
    height: integer("height"),
    isPrimary: boolean("is_primary").notNull().default(false),
    canonicalized: boolean("canonicalized").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("bottle_media_resource_url_uq").on(t.resourceId, t.url),
    index("bottle_media_bottle_idx").on(t.bottleId),
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
/**
 * A native sign-in that has been started but not yet completed: the app's PKCE
 * challenge and state nonce, parked for the length of the OAuth round trip
 * (docs/NATIVE_APP.md §2.3).
 *
 * The row's id is what `/api/auth/native/complete` requires before it will mint
 * anything, so an OAuth callback that no `/start` ever asked for produces no
 * code. It is consumed on first use, and the state is echoed from here rather
 * than carried through the provider, so nothing the app has to compare against
 * ever depends on a query parameter surviving Better Auth's redirect chain.
 */
export const nativeAuthRequests = pgTable(
  "native_auth_requests",
  {
    id: id(),
    /** base64url(SHA-256(code_verifier)) — PKCE S256, the app keeps the verifier. */
    codeChallenge: text("code_challenge").notNull(),
    /** Nonce the app echoes back to itself to recognise its own callback. */
    state: text("state").notNull(),
    /** Validated same-origin return path, held here rather than in the URL. */
    next: text("next"),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("native_auth_requests_expires_idx").on(t.expiresAt)],
);

export const nativeAuthCodes = pgTable(
  "native_auth_codes",
  {
    id: id(),
    codeHash: text("code_hash").notNull().unique(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    sessionCookieName: text("session_cookie_name").notNull(),
    /**
     * AES-256-GCM ciphertext of the session cookie, not the cookie (SEC-H2).
     * The plaintext is a weeks-long credential and this column is the kind of
     * thing that ends up in a backup or a replica; the key never does.
     */
    sessionCookie: text("session_cookie").notNull(),
    /**
     * The PKCE challenge from the `native_auth_requests` row this code was
     * minted for. Redemption requires a verifier that hashes to it, so a code
     * intercepted off the custom scheme by another app is inert. Nullable only
     * so the column could be added to a live table; a null is never redeemable.
     */
    codeChallenge: text("code_challenge"),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    /**
     * Vestigial. Redemption is now `DELETE … RETURNING`, so nothing ever sets
     * this and nothing reads it. It stays because production applies migrations
     * *before* the new build is activated (`scripts/build.mjs`), which means the
     * previous release serves traffic against this schema for the length of a
     * build — and that release still writes `used_at` on every redemption.
     * Dropping it here would fail every native sign-in during the rollout.
     * Drop it in a later deploy, once no running instance references it.
     */
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
export type NativeAuthRequest = typeof nativeAuthRequests.$inferSelect;
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
export type CatalogSource = typeof catalogSources.$inferSelect;
export type BottleResource = typeof bottleResources.$inferSelect;
export type BottleClaim = typeof bottleClaims.$inferSelect;
export type BottleMedia = typeof bottleMedia.$inferSelect;
export type Distillery = typeof distilleries.$inferSelect;
export type Bottle = typeof bottles.$inferSelect;
export type BottleSubmission = typeof bottleSubmissions.$inferSelect;
export type AgeVerification = typeof ageVerifications.$inferSelect;
export type ModerationAction = typeof moderationActions.$inferSelect;
export type Feedback = typeof feedback.$inferSelect;
export type NewBottle = typeof bottles.$inferInsert;
export type UserBottle = typeof userBottles.$inferSelect;
export type PassportTierRow = typeof passportTiers.$inferSelect;
export type Pour = typeof pours.$inferSelect;
export type CriticNote = typeof criticNotes.$inferSelect;
export type TastingNote = typeof tastingNotes.$inferSelect;
export type Pairing = typeof pairings.$inferSelect;
export type AiUsage = typeof aiUsage.$inferSelect;
export type AnalyticsEvent = typeof analyticsEvents.$inferSelect;
export type ChatSession = typeof chatSessions.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type RecExplanation = typeof recExplanations.$inferSelect;
