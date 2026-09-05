// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Table, getTableName, is } from "drizzle-orm";

import * as schema from "@/db/schema";
import PrivacyPage from "./page";

/**
 * The privacy policy claims to be an inventory: "written against the schema
 * rather than from a template". This test is what makes that claim checkable.
 *
 * It exists because the inventory was wrong. `chat_sessions` and
 * `chat_messages` keep every concierge question and answer for the life of
 * the account, and the policy did not mention them — not because anyone
 * decided they did not need mentioning, but because a table shipped and
 * nobody walked the list again. Prose cannot be kept in sync by intention;
 * every disclosure written since has been one person remembering.
 *
 * So the schema is the source of truth and every table has to be ACCOUNTED
 * FOR here, one of two ways: `disclosed` names the phrase in the policy that
 * covers it (and the phrase is asserted to actually be on the page, so
 * rewording the policy out from under a table fails too), or `notPersonal`
 * says in words why the table holds nothing about a person. Adding a table
 * without touching this file fails the suite with the question to answer.
 * Neither verdict can be given silently.
 *
 * **And a sentence about one table is not a disclosure of another.** The first
 * version of this file shipped with `blocks` and `reactions` both pointed at a
 * phrase about follows and comments — so the check passed while the policy
 * still told nobody that blocking someone or cheering a note is retained. The
 * enforcement was defeated in the same commit that introduced it, by the
 * cheapest possible move: reaching for a sentence that was already there
 * instead of writing the one the table needed. A phrase cannot describe every
 * table it is pointed at, and nothing here can read English to check.
 *
 * What it can check is that reuse was DELIBERATE. A phrase used by more than
 * one table must be declared on every one of them via `sharedWith`, naming the
 * others — so two tables share a sentence only when someone wrote down that
 * they are one disclosure (a session and its messages; a request and its code),
 * and pointing a new table at a convenient existing phrase fails until it is
 * either given its own sentence or declared as part of that one.
 *
 * **`notPersonal` is the second way past, and it cannot be closed the same
 * way.** `passport_tiers` shipped here exempted as "tier definitions for the
 * passport, identical for everyone" — a claim about the schema that the schema
 * flatly contradicts: `user_id`, `family`, `value`, `tier`, `achieved_at`, one
 * row per person per badge. Nothing mechanical catches that, because the
 * sentence is doing exactly what it was designed to do (record a judgement)
 * and the judgement was simply wrong. The only guard is that the claim has to
 * be WRITTEN, in words, next to the table it is about, where a reader can
 * check it against `schema.ts` — which is how this one was caught. So write
 * these as falsifiable statements about columns, never as reassurance, and
 * read the table definition before writing one.
 */

type Verdict = { disclosed: string; sharedWith?: string[] } | { notPersonal: string };

const INVENTORY: Record<string, Verdict> = {
  // --- Account and sign-in ---
  user: { disclosed: "the name, email address and" },
  session: { disclosed: "a session token plus the IP address" },
  account: { disclosed: "the tokens the provider issues for it" },
  verification: { notPersonal: "Better Auth's short-lived sign-in challenges, not user content." },
  native_auth_requests: {
    disclosed: "native sign-in codes are deleted the moment they are used",
    sharedWith: ["native_auth_codes"],
  },
  native_auth_codes: {
    disclosed: "native sign-in codes are deleted the moment they are used",
    sharedWith: ["native_auth_requests"],
  },

  // --- The journal ---
  pours: { disclosed: "pours, ratings, tasting", sharedWith: ["tasting_notes"] },
  tasting_notes: { disclosed: "pours, ratings, tasting", sharedWith: ["pours"] },
  user_bottles: { disclosed: "the bottles on your shelf, and what you paid" },
  pour_shares: { disclosed: "any share links you create" },
  // Was `notPersonal: "Tier definitions … identical for everyone"` — a claim
  // about the schema that the schema contradicts (user_id, family, value,
  // tier, achieved_at: one row per person per badge). See the file docstring:
  // a false exemption is the second way past this check, and the only guard
  // against it is that the sentence has to be written and can be read.
  passport_tiers: {
    disclosed: "which regions, countries, distilleries and cask types you have met",
  },

  // --- Age gate ---
  age_verifications: { disclosed: "the date of birth and" },

  // --- Social ---
  user_profiles: { disclosed: "your handle and profile", sharedWith: ["user_social_prefs"] },
  user_social_prefs: { disclosed: "your handle and profile", sharedWith: ["user_profiles"] },
  follows: { disclosed: "who you follow and who follows you" },
  blocks: { disclosed: "the accounts you have blocked" },
  reactions: { disclosed: "the notes you have cheered" },
  comments: { disclosed: "the comments you write" },
  phone_lookups: { disclosed: "We keep a keyed hash for exact-match lookup" },

  // --- Moderation and support ---
  reports: { disclosed: "Support messages and moderation records", sharedWith: ["moderation_actions"] },
  moderation_actions: { disclosed: "Support messages and moderation records", sharedWith: ["reports"] },
  feedback: { disclosed: "Anything you send us through support" },

  // --- AI ---
  chat_sessions: {
    disclosed: "every question you ask the AI and every answer it gives",
    sharedWith: ["chat_messages"],
  },
  chat_messages: {
    disclosed: "every question you ask the AI and every answer it gives",
    sharedWith: ["chat_sessions"],
  },
  ai_rate_limits: { disclosed: "rate-limit counters are dropped after a couple of days" },
  pairings: { notPersonal: "Generated pairing copy keyed to a bottle, not to a person." },
  pairing_generation_locks: { notPersonal: "A generation mutex; rows carry no user content." },
  // Same: "cached copy, regenerated from the journal" describes where it came
  // from, not what it is. It is per-user text keyed to `user_id`, stored.
  rec_explanations: { disclosed: "the\n            one-line reason behind a recommendation is cached against your account" },

  // --- Telemetry (WP-19) ---
  ai_usage: {
    disclosed: "which model answered, how many tokens it used, and how many web searches it ran",
  },
  analytics_events: { disclosed: "that a\n            share page was opened" },

  // --- Devices ---
  push_devices: { disclosed: "Device push tokens" },

  // --- Catalog: about bottles, not about people ---
  distilleries: { notPersonal: "Catalog reference data." },
  bottles: { notPersonal: "The shared bottle catalog." },
  // Also wrongly exempted, found by checking the rest after `passport_tiers`
  // rather than waiting to be told twice: the row ties a person to what they
  // proposed and carries the decision and decline reason written about them.
  // "The submitter is covered by the account bullet" was false — that bullet
  // covers a name and an email, not a submission history.
  bottle_submissions: { disclosed: "what you\n            proposed, the barcode if it came from a scan" },
  bottle_aliases: { notPersonal: "Alternative catalog names." },
  bottle_upcs: { notPersonal: "Barcodes against catalog rows." },
  critic_notes: { notPersonal: "Published critic notes, sourced and attributed." },
  price_history: { notPersonal: "Observed market prices for a bottle." },
  bottle_verifications: { notPersonal: "Catalog QA state." },
  catalog_sources: { notPersonal: "Where catalog data came from." },
  bottle_resources: { notPersonal: "Links attached to catalog rows." },
  bottle_claims: { notPersonal: "Sourced factual claims about a bottle." },
  bottle_media: { notPersonal: "Catalog imagery." },
  catalog_verification_runs: { notPersonal: "Catalog QA job state." },
  catalog_verification_work: { notPersonal: "Catalog QA job state." },
  catalog_verification_attempts: { notPersonal: "Catalog QA job state." },
};

/**
 * Every table in the schema, asked of Drizzle rather than scraped out of the
 * source: a rename, a table moved to another file, or one declared through a
 * helper all reach this list, where a regex over `schema.ts` would quietly
 * stop seeing them and let the check pass by finding nothing.
 */
function schemaTables(): string[] {
  return Object.values(schema as Record<string, unknown>)
    .filter((v): v is Table => is(v, Table))
    .map((t) => getTableName(t));
}

afterEach(cleanup);

describe("the privacy policy against the schema", () => {
  it("accounts for every table in the schema", () => {
    const missing = schemaTables().filter((t) => !(t in INVENTORY));
    // If this fails you have added a table. Decide which it is and say so in
    // INVENTORY: name the policy sentence that already covers it, or write the
    // one sentence explaining why it holds nothing about a person.
    expect(missing).toEqual([]);
  });

  it("does not carry entries for tables that no longer exist", () => {
    const tables = new Set(schemaTables());
    expect(Object.keys(INVENTORY).filter((t) => !tables.has(t))).toEqual([]);
  });

  it("says on the page what every disclosed table is disclosed by", () => {
    render(<PrivacyPage />);
    const text = document.body.textContent ?? "";
    // Rendered text collapses the source's line breaks; compare on words.
    const normalized = text.replace(/\s+/g, " ");
    const absent = Object.entries(INVENTORY)
      .flatMap(([table, verdict]) => ("disclosed" in verdict ? [[table, verdict.disclosed] as const] : []))
      .filter(([, phrase]) => !normalized.includes(phrase.replace(/\s+/g, " ")))
      .map(([table, phrase]) => `${table}: ${phrase}`);
    expect(absent).toEqual([]);
  });

  it("does not let one table's sentence stand in as another's disclosure", () => {
    const byPhrase = new Map<string, string[]>();
    for (const [table, verdict] of Object.entries(INVENTORY)) {
      if (!("disclosed" in verdict)) continue;
      byPhrase.set(verdict.disclosed, [...(byPhrase.get(verdict.disclosed) ?? []), table]);
    }
    // Sharing has to be declared from BOTH sides: the set of tables using a
    // phrase must be exactly what each of them says it is. Pointing a new table
    // at an existing sentence therefore fails until somebody either writes it
    // its own or names it in the others' `sharedWith`.
    const undeclared: string[] = [];
    for (const [phrase, tables] of byPhrase) {
      for (const table of tables) {
        const verdict = INVENTORY[table];
        if (!("disclosed" in verdict)) continue;
        const declared = new Set([table, ...(verdict.sharedWith ?? [])]);
        const actual = new Set(tables);
        if (declared.size !== actual.size || [...actual].some((t) => !declared.has(t))) {
          undeclared.push(`${table} shares "${phrase}" with ${tables.filter((t) => t !== table).join(", ")} without declaring it`);
        }
      }
    }
    expect(undeclared).toEqual([]);
  });

  it("tells the reader that blocking and cheering are retained", () => {
    render(<PrivacyPage />);
    // The specific omission the rule above was written for: both of these were
    // covered by a sentence about follows and comments, which mentions neither.
    expect(screen.getByText(/the accounts you have blocked/)).toBeInTheDocument();
    expect(screen.getByText(/the notes you have cheered/)).toBeInTheDocument();
    // A block outlives the thing it is attached to, which is worth saying.
    expect(screen.getByText(/A block is kept until you lift it/)).toBeInTheDocument();
  });

  it("does not promise that a withdrawn cheer survives account deletion", () => {
    render(<PrivacyPage />);
    /**
     * `ai_usage.user_id` and `analytics_events.user_id` are `set null`, so those
     * rows outlive the account unattributed. `reactions.user_id` is NOT NULL and
     * cascades, so a withdrawn cheer is erased outright — and a first draft of
     * the paragraph above swept all three into one sentence about unlinking,
     * which made the retention disclosure false for a third of what it named.
     *
     * A page that oversells what it keeps is the failure this file exists for;
     * a page that oversells what it DELETES is the same failure pointing the
     * other way, and it is the more tempting one to write.
     */
    expect(screen.getByText(/A cheer you took back is different, and goes with the account/)).toBeInTheDocument();
    expect(screen.getByText(/It is deleted outright/)).toBeInTheDocument();
  });

  it("says which account a share event names, not just that somebody was signed in", () => {
    render(<PrivacyPage />);
    /**
     * `analytics_events.user_id` is a foreign key to the account, not a
     * boolean. The disclosure used to describe it as "whether you were signed
     * in", which understates the identifiability of the row it is describing —
     * and a privacy page that undersells what it holds is the one failure mode
     * this whole file exists to catch.
     */
    expect(screen.getByText(/which account/)).toBeInTheDocument();
    expect(screen.getByText(/your user id, not/)).toBeInTheDocument();
    // And all four events, not the three that existed before `share_shelf_add`.
    expect(screen.getByText(/Four things about share links/)).toBeInTheDocument();
    expect(screen.getByText(/straight onto your shelf/)).toBeInTheDocument();
  });

  it("still tells the reader what the concierge keeps and for how long", () => {
    render(<PrivacyPage />);
    // The specific omission this file was written for, asserted in its own
    // right: both halves matter, because "we store your conversations" without
    // "for the life of the account" is the half that flatters us.
    expect(screen.getByText(/Your concierge conversations/)).toBeInTheDocument();
    expect(
      screen.getByText(/Concierge conversations are kept for the life of the account/),
    ).toBeInTheDocument();
  });
});
