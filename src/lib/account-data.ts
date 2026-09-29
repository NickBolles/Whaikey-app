import { and, count, eq, inArray, ne, notExists, sql, type SQL } from "drizzle-orm";
import { alias, type PgTable } from "drizzle-orm/pg-core";
import { strToU8, zipSync } from "fflate";
import type { DB } from "@/db";
import {
  account,
  ageVerifications,
  aiRateLimits,
  aiUsage,
  analyticsEvents,
  blocks,
  bottleSubmissions,
  bottles,
  chatMessages,
  chatSessions,
  comments,
  feedback,
  follows,
  moderationActions,
  nativeAuthCodes,
  passportTiers,
  phoneLookups,
  pourShares,
  pours,
  pushDevices,
  reactions,
  recExplanations,
  reports,
  session,
  tastingNotes,
  user,
  userBottles,
  userProfiles,
  userSocialPrefs,
} from "@/db/schema";

/**
 * What happens to a person's data when they export it and when they delete
 * the account (WP-11; PLAN.md §9.2; review SEC-M5).
 *
 * **One list, three readers.** The export builds its sections from it, the
 * deletion is checked against it, and the tests walk it against the schema —
 * so the statement of policy and the thing that carries it out cannot drift
 * apart, which is the failure `/privacy`'s inventory test was written after.
 * Every table in `schema.ts` is either sliced here or named in `NOT_LINKED`
 * with the reason it holds nothing about an account; a new table with neither
 * fails `account-data.test.ts` with the question to answer.
 *
 * A table can appear more than once. `follows` is two different things to the
 * person being deleted — the accounts they follow and the accounts following
 * them — and `bottles` holds both a pending submission (deleted) and a catalog
 * row they happened to add first (kept, unlinked). Each slice is a question
 * with its own answer, so each gets its own row here.
 *
 * The three outcomes, and what each promises:
 *
 * - **deleted** — no row in the slice survives the account.
 * - **unlinked** — the rows survive and stop naming the account. Only for
 *   things that are a record of something that happened to or about somebody
 *   else (a complaint, an AI call the provider billed, a catalog bottle
 *   everybody's shelf points at), where erasing the row would rewrite
 *   another party's history rather than the leaver's.
 * - **kept** — the rows survive unchanged. One slice: reports *about* the
 *   account's content, which are moderation records written by other people.
 */

export type DeletionOutcome = "deleted" | "unlinked" | "kept";

/** A column value: text, number, boolean, a timestamp, or a JSON document. */
export type ExportRow = Record<string, unknown>;

export interface ExportSpec {
  /** Column order for the CSV — fixed, so an empty section still has a header. */
  columns: readonly string[];
  rows: (db: DB, userId: string) => Promise<ExportRow[]>;
}

export interface DataSlice {
  /** Stable name: the export section, the CSV file name, the test's handle. */
  key: string;
  table: PgTable;
  /** What these rows are, in words a person reading their export would use. */
  description: string;
  onDelete: DeletionOutcome;
  /** Why that outcome — a statement about columns, not reassurance. */
  why: string;
  /** Selects this account's rows in the slice. */
  where: (db: DB, userId: string) => SQL | undefined;
  /** Present when the slice is exported; otherwise `notExported` says why not. */
  export?: ExportSpec;
  notExported?: string;
}

const ownPourIds = (db: DB, userId: string) =>
  db.select({ id: pours.id }).from(pours).where(eq(pours.userId, userId));

const ownShareIds = (db: DB, userId: string) =>
  db.select({ id: pourShares.id }).from(pourShares).where(eq(pourShares.userId, userId));

const ownChatIds = (db: DB, userId: string) =>
  db.select({ id: chatSessions.id }).from(chatSessions).where(eq(chatSessions.userId, userId));

/**
 * The other party in a follow or block, by handle only.
 *
 * A handle is what that person chose to be found by. Their user id is an
 * internal key and their display name is profile content they control — and
 * neither is needed to recognise who a line is about.
 */
const otherProfile = alias(userProfiles, "other_profile");

export const ACCOUNT_DATA: readonly DataSlice[] = [
  // --- The account and signing in -----------------------------------------
  {
    key: "account",
    table: user,
    description: "Your account: the name, email address and avatar your sign-in provider gave us.",
    onDelete: "deleted",
    why: "The row every other slice hangs off; deleting it is the deletion.",
    where: (_db, userId) => eq(user.id, userId),
    export: {
      columns: ["name", "email", "image", "createdAt", "updatedAt", "palateProfile"],
      rows: (db, userId) =>
        db
          .select({
            name: user.name,
            email: user.email,
            image: user.image,
            createdAt: user.createdAt,
            updatedAt: user.updatedAt,
            palateProfile: user.palateProfile,
          })
          .from(user)
          .where(eq(user.id, userId)),
    },
  },
  {
    key: "sign_in_methods",
    table: account,
    description: "Which provider you sign in with, and the id it knows you by.",
    onDelete: "deleted",
    why: "A link between the account and Google or Apple; with no account it links nothing.",
    where: (_db, userId) => eq(account.userId, userId),
    export: {
      // Never the tokens: they are credentials the provider issued, not data
      // you gave us, and a copy in a file is a copy outside our encryption.
      columns: ["providerId", "accountId", "createdAt"],
      rows: (db, userId) =>
        db
          .select({ providerId: account.providerId, accountId: account.accountId, createdAt: account.createdAt })
          .from(account)
          .where(eq(account.userId, userId)),
    },
  },
  {
    key: "sessions",
    table: session,
    description: "Each device signed in: when, from which IP address and browser.",
    onDelete: "deleted",
    why: "Deleting them is what signs every device out at once.",
    where: (_db, userId) => eq(session.userId, userId),
    export: {
      // Never the token. An export is a file that gets copied around, and a
      // live session token in it is a way into the account.
      columns: ["createdAt", "expiresAt", "ipAddress", "userAgent"],
      rows: (db, userId) =>
        db
          .select({
            createdAt: session.createdAt,
            expiresAt: session.expiresAt,
            ipAddress: session.ipAddress,
            userAgent: session.userAgent,
          })
          .from(session)
          .where(eq(session.userId, userId)),
    },
  },
  {
    key: "native_sign_in_codes",
    table: nativeAuthCodes,
    description: "One-time codes that hand a sign-in from the browser to the app.",
    onDelete: "deleted",
    why: "Each holds an encrypted session cookie; one surviving the account would be a way back in.",
    where: (_db, userId) => eq(nativeAuthCodes.userId, userId),
    notExported:
      "Single-use credentials that live for sixty seconds. There is nothing in them you wrote, and a copy would be a key.",
  },
  {
    key: "push_devices",
    table: pushDevices,
    description: "Devices registered for notifications.",
    onDelete: "deleted",
    why: "Without the row there is nothing to send to, so nothing can be sent.",
    where: (_db, userId) => eq(pushDevices.userId, userId),
    export: {
      // The token addresses the device through Apple or Google; it is not
      // yours to read and anybody holding it can target that phone.
      columns: ["platform", "createdAt", "updatedAt"],
      rows: (db, userId) =>
        db
          .select({ platform: pushDevices.platform, createdAt: pushDevices.createdAt, updatedAt: pushDevices.updatedAt })
          .from(pushDevices)
          .where(eq(pushDevices.userId, userId)),
    },
  },
  {
    key: "age_answer",
    table: ageVerifications,
    description: "The date of birth and market you gave the age gate.",
    onDelete: "deleted",
    why:
      "The most sensitive single fact we hold. Keeping it to stop somebody re-answering the gate on a new account would keep a birth date for a person who asked us to forget them — and a new sign-in could answer differently anyway.",
    where: (_db, userId) => eq(ageVerifications.userId, userId),
    export: {
      columns: ["birthDate", "market", "minimumAge", "passed", "eligibleOn", "createdAt"],
      rows: (db, userId) =>
        db
          .select({
            birthDate: ageVerifications.birthDate,
            market: ageVerifications.market,
            minimumAge: ageVerifications.minimumAge,
            passed: ageVerifications.passed,
            eligibleOn: ageVerifications.eligibleOn,
            createdAt: ageVerifications.createdAt,
          })
          .from(ageVerifications)
          .where(eq(ageVerifications.userId, userId)),
    },
  },

  // --- The journal -----------------------------------------------------------
  {
    key: "shelf",
    table: userBottles,
    description: "The bottles on your shelf, tried list and wishlist — and what you paid.",
    onDelete: "deleted",
    why: "Yours alone; nothing else reads another person's shelf.",
    where: (_db, userId) => eq(userBottles.userId, userId),
    export: {
      columns: [
        "id",
        "bottleId",
        "bottleName",
        "relationship",
        "status",
        "fillLevel",
        "quantity",
        "purchasePrice",
        "purchaseDate",
        "store",
        "estValue",
        "location",
        "notes",
        "createdAt",
        "updatedAt",
      ],
      rows: (db, userId) =>
        db
          .select({
            id: userBottles.id,
            bottleId: userBottles.bottleId,
            bottleName: bottles.name,
            relationship: userBottles.relationship,
            status: userBottles.status,
            fillLevel: userBottles.fillLevel,
            quantity: userBottles.quantity,
            purchasePrice: userBottles.purchasePrice,
            purchaseDate: userBottles.purchaseDate,
            store: userBottles.store,
            estValue: userBottles.estValue,
            location: userBottles.location,
            notes: userBottles.notes,
            createdAt: userBottles.createdAt,
            updatedAt: userBottles.updatedAt,
          })
          .from(userBottles)
          .innerJoin(bottles, eq(bottles.id, userBottles.bottleId))
          .where(eq(userBottles.userId, userId))
          .orderBy(userBottles.createdAt, userBottles.id),
    },
  },
  {
    key: "pours",
    table: pours,
    description: "Every pour you logged: bottle, rating, serving, size, and who could see it.",
    onDelete: "deleted",
    why:
      "Community numbers are computed from published pours when they are read, never stored, so a deleted pour leaves every average the next time it is asked for — and the three-person floor still applies to what remains.",
    where: (_db, userId) => eq(pours.userId, userId),
    export: {
      columns: ["id", "bottleId", "bottleName", "rating", "servingStyle", "amountMl", "context", "visibility", "createdAt"],
      rows: (db, userId) =>
        db
          .select({
            id: pours.id,
            bottleId: pours.bottleId,
            bottleName: bottles.name,
            rating: pours.rating,
            servingStyle: pours.servingStyle,
            amountMl: pours.amountMl,
            context: pours.context,
            visibility: pours.visibility,
            createdAt: pours.createdAt,
          })
          .from(pours)
          .innerJoin(bottles, eq(bottles.id, pours.bottleId))
          .where(eq(pours.userId, userId))
          .orderBy(pours.createdAt, pours.id),
    },
  },
  {
    key: "tasting_notes",
    table: tastingNotes,
    description: "What you wrote about each pour: nose, palate, finish, notes and flavour tags.",
    onDelete: "deleted",
    why: "Goes with its pour.",
    where: (db, userId) => inArray(tastingNotes.pourId, ownPourIds(db, userId)),
    export: {
      columns: ["pourId", "nose", "palate", "finish", "freeform", "flavorTags", "extractedBy", "createdAt"],
      rows: (db, userId) =>
        db
          .select({
            pourId: tastingNotes.pourId,
            nose: tastingNotes.nose,
            palate: tastingNotes.palate,
            finish: tastingNotes.finish,
            freeform: tastingNotes.freeform,
            flavorTags: tastingNotes.flavorTags,
            extractedBy: tastingNotes.extractedBy,
            createdAt: tastingNotes.createdAt,
          })
          .from(tastingNotes)
          .innerJoin(pours, eq(pours.id, tastingNotes.pourId))
          .where(eq(pours.userId, userId))
          .orderBy(tastingNotes.createdAt, tastingNotes.id),
    },
  },
  {
    key: "share_links",
    table: pourShares,
    description: "Share links you created, and when you revoked them.",
    onDelete: "deleted",
    why: "Deleting the row is what makes every link stop opening, immediately.",
    where: (_db, userId) => eq(pourShares.userId, userId),
    export: {
      // Not the code. A live share code is a bearer credential for your note,
      // and an export is a file that travels; the list at /settings is where
      // the links themselves live.
      columns: ["pourId", "locationLabel", "createdAt", "revokedAt"],
      rows: (db, userId) =>
        db
          .select({
            pourId: pourShares.pourId,
            locationLabel: pourShares.locationLabel,
            createdAt: pourShares.createdAt,
            revokedAt: pourShares.revokedAt,
          })
          .from(pourShares)
          .where(eq(pourShares.userId, userId))
          .orderBy(pourShares.createdAt, pourShares.id),
    },
  },
  {
    key: "passport",
    table: passportTiers,
    description: "The passport tiers you reached, and when.",
    onDelete: "deleted",
    why: "A record of what you have tried, derived from the journal it goes with.",
    where: (_db, userId) => eq(passportTiers.userId, userId),
    export: {
      columns: ["family", "value", "tier", "achievedAt"],
      rows: (db, userId) =>
        db
          .select({
            family: passportTiers.family,
            value: passportTiers.value,
            tier: passportTiers.tier,
            achievedAt: passportTiers.achievedAt,
          })
          .from(passportTiers)
          .where(eq(passportTiers.userId, userId))
          .orderBy(passportTiers.achievedAt, passportTiers.id),
    },
  },
  {
    key: "recommendation_reasons",
    table: recExplanations,
    description: "The cached one-line reason behind a recommendation.",
    onDelete: "deleted",
    why: "Written from your journal and about nobody else.",
    where: (_db, userId) => eq(recExplanations.userId, userId),
    export: {
      columns: ["bottleId", "bottleName", "mode", "reason", "createdAt"],
      rows: (db, userId) =>
        db
          .select({
            bottleId: recExplanations.bottleId,
            bottleName: bottles.name,
            mode: recExplanations.mode,
            reason: recExplanations.reason,
            createdAt: recExplanations.createdAt,
          })
          .from(recExplanations)
          .innerJoin(bottles, eq(bottles.id, recExplanations.bottleId))
          .where(eq(recExplanations.userId, userId))
          .orderBy(recExplanations.createdAt, recExplanations.id),
    },
  },
  {
    key: "concierge_conversations",
    table: chatSessions,
    description: "Your concierge conversations.",
    onDelete: "deleted",
    why: "Kept for the life of the account, and that is the end of it.",
    where: (_db, userId) => eq(chatSessions.userId, userId),
    export: {
      columns: ["id", "title", "createdAt", "updatedAt"],
      rows: (db, userId) =>
        db
          .select({ id: chatSessions.id, title: chatSessions.title, createdAt: chatSessions.createdAt, updatedAt: chatSessions.updatedAt })
          .from(chatSessions)
          .where(eq(chatSessions.userId, userId))
          .orderBy(chatSessions.createdAt, chatSessions.id),
    },
  },
  {
    key: "concierge_messages",
    table: chatMessages,
    description: "Every message in those conversations, with what the concierge looked up to answer.",
    onDelete: "deleted",
    why: "Goes with its conversation.",
    where: (db, userId) => inArray(chatMessages.sessionId, ownChatIds(db, userId)),
    export: {
      columns: ["conversationId", "role", "content", "toolCalls", "createdAt"],
      rows: (db, userId) =>
        db
          .select({
            conversationId: chatMessages.sessionId,
            role: chatMessages.role,
            content: chatMessages.content,
            toolCalls: chatMessages.toolCalls,
            createdAt: chatMessages.createdAt,
          })
          .from(chatMessages)
          .innerJoin(chatSessions, eq(chatSessions.id, chatMessages.sessionId))
          .where(eq(chatSessions.userId, userId))
          .orderBy(chatMessages.createdAt, chatMessages.id),
    },
  },

  // --- What you added to the catalog ------------------------------------------
  {
    key: "bottle_submissions",
    table: bottleSubmissions,
    description: "Bottles you proposed for the catalog, and the decision on each.",
    onDelete: "deleted",
    why: "Your proposal and the reviewer's note to you; a promoted bottle does not need either to stay in the catalog.",
    where: (_db, userId) => eq(bottleSubmissions.submittedBy, userId),
    export: {
      columns: [
        "bottleId",
        "bottleName",
        "category",
        "country",
        "region",
        "ageYears",
        "abv",
        "distilleryText",
        "upc",
        "source",
        "state",
        "reviewNote",
        "reviewedAt",
        "createdAt",
      ],
      rows: (db, userId) =>
        db
          .select({
            bottleId: bottleSubmissions.bottleId,
            bottleName: bottles.name,
            category: bottles.category,
            country: bottles.country,
            region: bottles.region,
            ageYears: bottles.ageYears,
            abv: bottles.abv,
            distilleryText: bottleSubmissions.distilleryText,
            upc: bottleSubmissions.upc,
            source: bottleSubmissions.source,
            state: bottleSubmissions.state,
            reviewNote: bottleSubmissions.reviewNote,
            reviewedAt: bottleSubmissions.reviewedAt,
            createdAt: bottleSubmissions.createdAt,
          })
          .from(bottleSubmissions)
          .innerJoin(bottles, eq(bottles.id, bottleSubmissions.bottleId))
          .where(eq(bottleSubmissions.submittedBy, userId))
          .orderBy(bottleSubmissions.createdAt, bottleSubmissions.id),
    },
  },
  {
    key: "pending_bottles",
    table: bottles,
    description: "Bottles you added that were never promoted into the shared catalog.",
    onDelete: "deleted",
    why:
      "Visible only to their submitter (`catalogVisibleTo`), so with the submitter gone they would be visible to nobody and reviewable by nobody. Deleted in the same transaction rather than left to the nightly sweep.",
    where: (_db, userId) => and(eq(bottles.status, "user_submitted"), eq(bottles.submittedBy, userId)),
    notExported: "Everything you typed is in bottle_submissions.",
  },
  {
    key: "catalog_bottles_you_added",
    table: bottles,
    description: "Bottles you added first that are now in the shared catalog.",
    onDelete: "unlinked",
    why: "Everybody's shelf and journal point at a catalog bottle, so it stays; it stops saying who added it.",
    where: (_db, userId) => and(ne(bottles.status, "user_submitted"), eq(bottles.submittedBy, userId)),
    notExported: "Shared catalog data, not yours. What you proposed is in bottle_submissions.",
  },
  {
    key: "submissions_you_reviewed",
    table: bottleSubmissions,
    description: "Catalog decisions you made as an operator.",
    onDelete: "unlinked",
    why: "The decision is somebody else's record of their submission; it keeps its outcome and stops naming the reviewer.",
    where: (_db, userId) => eq(bottleSubmissions.reviewedBy, userId),
    notExported: "Operator records about other people's submissions.",
  },

  // --- Social ----------------------------------------------------------------------
  {
    key: "profile",
    table: userProfiles,
    description: "Your handle and profile, and the switches on it.",
    onDelete: "deleted",
    why: "The handle becomes free again; links to /u/<handle> stop resolving to you at once.",
    where: (_db, userId) => eq(userProfiles.userId, userId),
    export: {
      // Never `phoneHash`: a keyed hash of your number is only useful to
      // somebody holding the key, which is not you, and is the thing an
      // enumeration would want.
      columns: [
        "handle",
        "displayName",
        "avatarUrl",
        "bio",
        "homeRegion",
        "isPublic",
        "discoverable",
        "socialEnabled",
        "phoneLast2",
        "phoneDiscoverable",
        "suspendedAt",
        "suspendedReason",
        "createdAt",
        "updatedAt",
      ],
      rows: (db, userId) =>
        db
          .select({
            handle: userProfiles.handle,
            displayName: userProfiles.displayName,
            avatarUrl: userProfiles.avatarUrl,
            bio: userProfiles.bio,
            homeRegion: userProfiles.homeRegion,
            isPublic: userProfiles.isPublic,
            discoverable: userProfiles.discoverable,
            socialEnabled: userProfiles.socialEnabled,
            phoneLast2: userProfiles.phoneLast2,
            phoneDiscoverable: userProfiles.phoneDiscoverable,
            suspendedAt: userProfiles.suspendedAt,
            suspendedReason: userProfiles.suspendedReason,
            createdAt: userProfiles.createdAt,
            updatedAt: userProfiles.updatedAt,
          })
          .from(userProfiles)
          .where(eq(userProfiles.userId, userId)),
    },
  },
  {
    key: "social_preferences",
    table: userSocialPrefs,
    description: "Your default pour visibility and whether people may comment.",
    onDelete: "deleted",
    why: "Settings for an account that no longer exists.",
    where: (_db, userId) => eq(userSocialPrefs.userId, userId),
    export: {
      columns: ["defaultPourVisibility", "allowComments", "notifyPrefs", "createdAt", "updatedAt"],
      rows: (db, userId) =>
        db
          .select({
            defaultPourVisibility: userSocialPrefs.defaultPourVisibility,
            allowComments: userSocialPrefs.allowComments,
            notifyPrefs: userSocialPrefs.notifyPrefs,
            createdAt: userSocialPrefs.createdAt,
            updatedAt: userSocialPrefs.updatedAt,
          })
          .from(userSocialPrefs)
          .where(eq(userSocialPrefs.userId, userId)),
    },
  },
  {
    key: "phone_lookups",
    table: phoneLookups,
    description: "When you looked somebody up by phone number (never the number you looked up).",
    onDelete: "deleted",
    why: "Rate-limit bookkeeping for an account that can no longer look anyone up.",
    where: (_db, userId) => eq(phoneLookups.userId, userId),
    export: {
      columns: ["createdAt"],
      rows: (db, userId) =>
        db
          .select({ createdAt: phoneLookups.createdAt })
          .from(phoneLookups)
          .where(eq(phoneLookups.userId, userId))
          .orderBy(phoneLookups.createdAt),
    },
  },
  {
    key: "following",
    table: follows,
    description: "Accounts you follow, or asked to.",
    onDelete: "deleted",
    why: "You leave their followers lists.",
    where: (_db, userId) => eq(follows.followerId, userId),
    export: {
      columns: ["handle", "state", "createdAt"],
      rows: (db, userId) =>
        db
          .select({ handle: otherProfile.handle, state: follows.state, createdAt: follows.createdAt })
          .from(follows)
          .leftJoin(otherProfile, eq(otherProfile.userId, follows.followeeId))
          .where(eq(follows.followerId, userId))
          .orderBy(follows.createdAt, follows.id),
    },
  },
  {
    key: "followers",
    table: follows,
    description: "Accounts that follow you, or asked to.",
    onDelete: "deleted",
    why: "You leave their following lists; there is nobody left to follow.",
    where: (_db, userId) => eq(follows.followeeId, userId),
    export: {
      columns: ["handle", "state", "createdAt"],
      rows: (db, userId) =>
        db
          .select({ handle: otherProfile.handle, state: follows.state, createdAt: follows.createdAt })
          .from(follows)
          .leftJoin(otherProfile, eq(otherProfile.userId, follows.followerId))
          .where(eq(follows.followeeId, userId))
          .orderBy(follows.createdAt, follows.id),
    },
  },
  {
    key: "blocked",
    table: blocks,
    description: "Accounts you blocked.",
    onDelete: "deleted",
    why: "A block protects an account; with the account gone there is nothing left for it to protect.",
    where: (_db, userId) => eq(blocks.blockerId, userId),
    export: {
      columns: ["handle", "createdAt"],
      rows: (db, userId) =>
        db
          .select({ handle: otherProfile.handle, createdAt: blocks.createdAt })
          .from(blocks)
          .leftJoin(otherProfile, eq(otherProfile.userId, blocks.blockedId))
          .where(eq(blocks.blockerId, userId))
          .orderBy(blocks.createdAt, blocks.id),
    },
  },
  {
    key: "blocks_against_you",
    table: blocks,
    description: "Blocks other people placed on you.",
    onDelete: "deleted",
    why: "They point at an account that no longer exists.",
    where: (_db, userId) => eq(blocks.blockedId, userId),
    notExported:
      "Whether somebody blocked you is their decision, and telling you in a file would undo the one thing a block is for.",
  },
  {
    key: "cheers_given",
    table: reactions,
    description: "Notes you cheered, including cheers you took back.",
    onDelete: "deleted",
    why:
      "Something you did on somebody else's note. There is no version of it with your name taken off — an anonymous cheer would be a thing we invented — so it goes, and that note's count drops by one.",
    where: (_db, userId) => eq(reactions.userId, userId),
    export: {
      // The pour's id and nothing about it. Which bottle a friend drank is
      // theirs, and it may have gone private since you cheered it.
      columns: ["pourId", "kind", "createdAt", "retractedAt"],
      rows: (db, userId) =>
        db
          .select({
            pourId: reactions.pourId,
            kind: reactions.kind,
            createdAt: reactions.createdAt,
            retractedAt: reactions.retractedAt,
          })
          .from(reactions)
          .where(eq(reactions.userId, userId))
          .orderBy(reactions.createdAt, reactions.id),
    },
  },
  {
    key: "cheers_on_your_notes",
    table: reactions,
    description: "Cheers other people gave your notes.",
    onDelete: "deleted",
    why: "They were attached to your notes, and the notes are gone.",
    where: (db, userId) => and(inArray(reactions.pourId, ownPourIds(db, userId)), ne(reactions.userId, userId)),
    notExported: "Other people's actions, not yours.",
  },
  {
    key: "comments_written",
    table: comments,
    description: "Comments you wrote, on anybody's notes.",
    onDelete: "deleted",
    why:
      "Deleted outright rather than left as a “[deleted]” tombstone: the words are what you are owed the removal of, and a tombstone keeps the row, its time and its place in somebody's thread. Replies other people wrote to yours stay on their thread — it already renders a reply whose parent is gone as a top-level comment.",
    where: (_db, userId) => eq(comments.userId, userId),
    export: {
      columns: ["id", "pourId", "parentId", "body", "createdAt", "editedAt", "deletedAt"],
      rows: (db, userId) =>
        db
          .select({
            id: comments.id,
            pourId: comments.pourId,
            parentId: comments.parentId,
            body: comments.body,
            createdAt: comments.createdAt,
            editedAt: comments.editedAt,
            deletedAt: comments.deletedAt,
          })
          .from(comments)
          .where(eq(comments.userId, userId))
          .orderBy(comments.createdAt, comments.id),
    },
  },
  {
    key: "comments_on_your_notes",
    table: comments,
    description: "Comments other people wrote on your notes.",
    onDelete: "deleted",
    why: "A comment is part of the note it is under, and the note is gone.",
    where: (db, userId) => and(inArray(comments.pourId, ownPourIds(db, userId)), ne(comments.userId, userId)),
    notExported: "Other people's words.",
  },

  // --- Moderation and support ----------------------------------------------------
  {
    key: "reports_filed",
    table: reports,
    description: "Reports you filed about other people's content.",
    onDelete: "unlinked",
    why:
      "A complaint about somebody else's content outlives the person who raised it — an open one still has to be judged — so it stays in the queue and stops naming you.",
    where: (_db, userId) => eq(reports.reporterId, userId),
    export: {
      // Not what was reported or the copy of it: that is the other person's
      // content, and it may have been taken down since.
      columns: ["subjectType", "reason", "state", "createdAt"],
      rows: (db, userId) =>
        db
          .select({ subjectType: reports.subjectType, reason: reports.reason, state: reports.state, createdAt: reports.createdAt })
          .from(reports)
          .where(eq(reports.reporterId, userId))
          .orderBy(reports.createdAt, reports.id),
    },
  },
  {
    key: "reports_about_you",
    table: reports,
    description: "Reports other people filed about your content, with the copy of it they reported.",
    onDelete: "kept",
    why:
      "Moderation records, kept indefinitely as `/privacy` says: what an operator decides from, and the evidence a report is judged on. The content itself is deleted with the account; the report's copy of what was reported is not.",
    where: (_db, userId) => eq(reports.subjectOwnerId, userId),
    notExported:
      "The reporter's reason is their words, not yours. Anything moderation did about your content is shown to you on the settings page while the account exists.",
  },
  {
    key: "moderation_decisions_you_made",
    table: moderationActions,
    description: "Moderation decisions you made as an operator.",
    onDelete: "unlinked",
    why: "The trail is append-only and is what an appeal is answered from; it keeps the decision and stops naming the operator.",
    where: (_db, userId) => eq(moderationActions.actorId, userId),
    notExported: "Operator records about other people.",
  },
  {
    key: "support_messages",
    table: feedback,
    description: "Messages you sent through support while signed in.",
    onDelete: "deleted",
    why:
      "Nothing needs them once the account is gone — `/privacy` already says they were kept only because nothing pruned them. A message sent signed out was never linked to you and cannot be found by this.",
    where: (_db, userId) => eq(feedback.userId, userId),
    export: {
      columns: ["body", "contact", "platform", "appVersion", "createdAt", "handledAt"],
      rows: (db, userId) =>
        db
          .select({
            body: feedback.body,
            contact: feedback.contact,
            platform: feedback.platform,
            appVersion: feedback.appVersion,
            createdAt: feedback.createdAt,
            handledAt: feedback.handledAt,
          })
          .from(feedback)
          .where(eq(feedback.userId, userId))
          .orderBy(feedback.createdAt, feedback.id),
    },
  },

  // --- AI and telemetry ----------------------------------------------------------
  {
    key: "ai_rate_limits",
    table: aiRateLimits,
    description: "Counters of how many AI requests you made in the current hour and day.",
    onDelete: "deleted",
    why: "An allowance for an account that no longer exists.",
    where: (_db, userId) => eq(aiRateLimits.userId, userId),
    export: {
      columns: ["window", "windowStart", "count"],
      rows: (db, userId) =>
        db
          .select({ window: aiRateLimits.window, windowStart: aiRateLimits.windowStart, count: aiRateLimits.count })
          .from(aiRateLimits)
          .where(eq(aiRateLimits.userId, userId))
          .orderBy(aiRateLimits.windowStart),
    },
  },
  {
    key: "ai_usage",
    table: aiUsage,
    description: "For each AI request: the feature, the model, and how many tokens and searches it used.",
    onDelete: "unlinked",
    why:
      "A meter reading of a call the provider billed. Erasing it would make last month's cost say the call never happened; it stops naming you and expires on the 90-day telemetry sweep.",
    where: (_db, userId) => eq(aiUsage.userId, userId),
    export: {
      columns: [
        "feature",
        "model",
        "inputTokens",
        "outputTokens",
        "cachedInputTokens",
        "cacheWriteTokens",
        "webSearchRequests",
        "webFetchRequests",
        "createdAt",
      ],
      rows: (db, userId) =>
        db
          .select({
            feature: aiUsage.feature,
            model: aiUsage.model,
            inputTokens: aiUsage.inputTokens,
            outputTokens: aiUsage.outputTokens,
            cachedInputTokens: aiUsage.cachedInputTokens,
            cacheWriteTokens: aiUsage.cacheWriteTokens,
            webSearchRequests: aiUsage.webSearchRequests,
            webFetchRequests: aiUsage.webFetchRequests,
            createdAt: aiUsage.createdAt,
          })
          .from(aiUsage)
          .where(eq(aiUsage.userId, userId))
          .orderBy(aiUsage.createdAt, aiUsage.id),
    },
  },
  {
    key: "share_events",
    table: analyticsEvents,
    description: "Share pages you opened while signed in, and what you did from them.",
    onDelete: "unlinked",
    why: "A count of something that happened; it stops naming you and expires on the 90-day telemetry sweep.",
    where: (_db, userId) => eq(analyticsEvents.userId, userId),
    export: {
      // Not which link: that is a row id of somebody else's share.
      columns: ["name", "createdAt"],
      rows: (db, userId) =>
        db
          .select({ name: analyticsEvents.name, createdAt: analyticsEvents.createdAt })
          .from(analyticsEvents)
          .where(eq(analyticsEvents.userId, userId))
          .orderBy(analyticsEvents.createdAt, analyticsEvents.id),
    },
  },
  {
    key: "events_on_your_share_links",
    table: analyticsEvents,
    description: "Other people opening your share links.",
    onDelete: "unlinked",
    why: "Their activity, not yours; the event stops pointing at your (deleted) link and expires on the 90-day sweep.",
    where: (db, userId) => inArray(analyticsEvents.shareId, ownShareIds(db, userId)),
    notExported: "Other people's activity.",
  },
];

/**
 * Tables that hold nothing linked to an account, and why.
 *
 * Written as statements about columns, for the reason `/privacy`'s inventory
 * test gives: an exemption is the second way past a check like this one, and
 * the only guard is that it has to be written where it can be read against
 * `schema.ts`.
 */
export const NOT_LINKED: Readonly<Record<string, string>> = {
  verification: "Better Auth OAuth state keyed by an opaque identifier; no user id column, and it expires in minutes.",
  native_auth_requests: "A PKCE challenge and nonce for a sign-in not yet completed; no user id column, swept on expiry.",
  distilleries: "Catalog reference data; no user column.",
  bottle_aliases: "Alternative names for catalog bottles; no user column.",
  bottle_upcs: "Barcode → bottle map; no user column (a submitted barcode lives on bottle_submissions until promoted).",
  critic_notes: "Published critic notes; no user column.",
  price_history: "Observed market prices; no user column.",
  bottle_verifications: "Catalog QA evidence; no user column.",
  catalog_sources: "Where catalog data came from; no user column.",
  bottle_resources: "Links attached to catalog rows; no user column.",
  bottle_claims: "Sourced facts about a bottle; no user column.",
  bottle_media: "Catalog imagery; no user column.",
  catalog_verification_runs: "Catalog QA job state; no user column.",
  catalog_verification_work: "Catalog QA job state; no user column.",
  catalog_verification_attempts: "Catalog QA job state; no user column.",
  pairings: "Generated pairing copy keyed to a bottle; no user column.",
  pairing_generation_locks: "A generation mutex keyed to a bottle; no user column.",
};

/** How many of this account's rows a slice currently holds. */
export async function countSlice(db: DB, slice: DataSlice, userId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(slice.table).where(slice.where(db, userId));
  return Number(row?.n ?? 0);
}

// --- Export ---------------------------------------------------------------------

export const EXPORT_FORMAT_VERSION = 1;

export interface AccountExport {
  format: "whaikey-account-export";
  version: number;
  exportedAt: string;
  /** Section key → rows, in the registry's order. */
  data: Record<string, ExportRow[]>;
  /** What a reader might expect to find and will not, and why. */
  notIncluded: Array<{ section: string; description: string; why: string }>;
}

export async function buildAccountExport(db: DB, userId: string, now: Date): Promise<AccountExport> {
  const data: Record<string, ExportRow[]> = {};
  // Sequential on purpose: one connection in production (`max: 1`), and a
  // Promise.all over three dozen queries would only queue behind it.
  for (const slice of ACCOUNT_DATA) {
    if (slice.export) data[slice.key] = await slice.export.rows(db, userId);
  }
  return {
    format: "whaikey-account-export",
    version: EXPORT_FORMAT_VERSION,
    exportedAt: now.toISOString(),
    data,
    notIncluded: ACCOUNT_DATA.filter((s) => !s.export).map((s) => ({
      section: s.key,
      description: s.description,
      why: s.notExported ?? "",
    })),
  };
}

/**
 * One CSV cell, RFC 4180.
 *
 * Structured values (a pour's context, a note's flavour tags, the concierge's
 * tool calls) are JSON inside the cell rather than flattened: flattening
 * `flavorTags` into a column per descriptor would give every file a different
 * header. A text cell that a spreadsheet would run as a formula gets a leading
 * apostrophe — your own notes are safe to open, but a concierge message can
 * quote catalog text written by somebody else, and `=HYPERLINK(...)` in a
 * bottle description should not become a live link in your spreadsheet.
 * Numbers are left alone, so a negative number is still a number.
 */
export function csvCell(value: unknown): string {
  if (value == null) return "";
  let text: string;
  if (value instanceof Date) text = value.toISOString();
  else if (typeof value === "object") text = JSON.stringify(value);
  else text = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(columns: readonly string[], rows: readonly ExportRow[]): string {
  const lines = [columns.map((c) => csvCell(c)).join(",")];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

const CSV_README = `Whaikey — your data

One CSV file per section, UTF-8 with a byte-order mark so spreadsheet apps read
accents correctly. Times are ISO 8601 in UTC. Cells holding structured values
(flavour tags, pour context, concierge tool calls) contain JSON. A text cell
that begins with = + - @ has a leading apostrophe added so a spreadsheet does
not run it as a formula.

The same data is available as a single JSON file from the same page.
`;

/** The export as a zip of CSVs — one per section — plus a README. */
export function accountExportZip(exported: AccountExport): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const notes = exported.notIncluded.map((n) => `- ${n.section}: ${n.description} ${n.why}`).join("\n");
  files["README.txt"] = strToU8(
    `${CSV_README}\nExported ${exported.exportedAt}.\n\nNot included, and why:\n${notes}\n`,
  );
  for (const slice of ACCOUNT_DATA) {
    if (!slice.export) continue;
    const rows = exported.data[slice.key] ?? [];
    files[`${slice.key}.csv`] = strToU8(`\uFEFF${toCsv(slice.export.columns, rows)}`);
  }
  return zipSync(files, { level: 6 });
}

// --- Deletion -------------------------------------------------------------------


/**
 * Delete an account, all at once or not at all.
 *
 * Most of the policy above is carried by the schema's foreign keys — every
 * `deleted` slice that hangs off `user.id` cascades, every `unlinked` one is
 * `set null` — so deleting the user row is most of the work, and the explicit
 * steps are only the two things a foreign key cannot express:
 *
 * - **Support messages** are `set null` (a signed-out message has no user, so
 *   the column must be nullable), but the policy for a signed-in one is
 *   deletion.
 * - **Pending bottles** are `set null` too, because a *promoted* bottle has to
 *   outlive its submitter; an unpromoted one has to go with them. The same
 *   duplicate-target guard as `sweepOrphanedSubmissions`: a bottle another
 *   submission points at is spared rather than letting the delete throw.
 *
 * One transaction: a failure anywhere leaves the account exactly as it was,
 * never half-deleted with its sessions gone and its journal intact. Returns
 * false when there was no such account (already deleted, or a race with a
 * second tap) so the caller can answer 404 rather than claim a deletion.
 */
export async function deleteAccount(db: DB, userId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    // Row-lock the account first: a second concurrent deletion waits here and
    // then finds nothing, rather than both running the steps below.
    const [existing] = await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for("update");
    if (!existing) return false;

    await tx.delete(feedback).where(eq(feedback.userId, userId));

    const dupe = alias(bottleSubmissions, "dupe_of");
    await tx
      .delete(bottles)
      .where(
        and(
          eq(bottles.status, "user_submitted"),
          eq(bottles.submittedBy, userId),
          notExists(
            tx.select({ one: sql`1` }).from(dupe).where(eq(dupe.duplicateOfBottleId, bottles.id)),
          ),
        ),
      );

    await tx.delete(user).where(eq(user.id, userId));
    return true;
  });
}

/**
 * Which providers the account signs in with, for the Settings account card.
 * Only the provider names: the rows also hold tokens, and nothing on a page
 * needs to have read them.
 */
export async function signInProviders(db: DB, userId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ providerId: account.providerId })
    .from(account)
    .where(eq(account.userId, userId))
    .orderBy(account.providerId);
  return rows.map((r) => r.providerId);
}
