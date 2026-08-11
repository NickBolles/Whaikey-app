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
    createdAt: createdAt(),
  },
  (t) => [index("pour_shares_user_idx").on(t.userId)],
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
export type TastingNote = typeof tastingNotes.$inferSelect;
export type Pairing = typeof pairings.$inferSelect;
export type ChatSession = typeof chatSessions.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type RecExplanation = typeof recExplanations.$inferSelect;
