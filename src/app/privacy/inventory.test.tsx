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
 */

type Verdict = { disclosed: string } | { notPersonal: string };

const INVENTORY: Record<string, Verdict> = {
  // --- Account and sign-in ---
  user: { disclosed: "the name, email address and" },
  session: { disclosed: "a session token plus the IP address" },
  account: { disclosed: "the tokens the provider issues for it" },
  verification: { notPersonal: "Better Auth's short-lived sign-in challenges, not user content." },
  native_auth_requests: { disclosed: "native sign-in codes are deleted the moment they are used" },
  native_auth_codes: { disclosed: "native sign-in codes are deleted the moment they are used" },

  // --- The journal ---
  pours: { disclosed: "pours, ratings, tasting" },
  tasting_notes: { disclosed: "pours, ratings, tasting" },
  user_bottles: { disclosed: "the bottles on your shelf, and what you paid" },
  pour_shares: { disclosed: "and any share links you create" },
  passport_tiers: { notPersonal: "Tier definitions for the passport, identical for everyone." },

  // --- Age gate ---
  age_verifications: { disclosed: "the date of birth and" },

  // --- Social ---
  user_profiles: { disclosed: "your handle,\n            profile, who you follow, comments" },
  user_social_prefs: { disclosed: "your handle,\n            profile, who you follow, comments" },
  follows: { disclosed: "who you follow" },
  blocks: { disclosed: "who you follow" },
  reactions: { disclosed: "who you follow, comments" },
  comments: { disclosed: "who you follow, comments" },
  phone_lookups: { disclosed: "We keep a keyed hash for exact-match lookup" },

  // --- Moderation and support ---
  reports: { disclosed: "Support messages and moderation records" },
  moderation_actions: { disclosed: "Support messages and moderation records" },
  feedback: { disclosed: "Anything you send us through support" },

  // --- AI ---
  chat_sessions: { disclosed: "every\n            question you ask the AI and every answer it gives" },
  chat_messages: { disclosed: "every\n            question you ask the AI and every answer it gives" },
  ai_rate_limits: { disclosed: "rate-limit counters are dropped after a couple of days" },
  pairings: { notPersonal: "Generated pairing copy keyed to a bottle, not to a person." },
  pairing_generation_locks: { notPersonal: "A generation mutex; rows carry no user content." },
  rec_explanations: { notPersonal: "Cached recommendation copy, regenerated from the journal it describes." },

  // --- Devices ---
  push_devices: { disclosed: "Device push tokens" },

  // --- Catalog: about bottles, not about people ---
  distilleries: { notPersonal: "Catalog reference data." },
  bottles: { notPersonal: "The shared bottle catalog." },
  bottle_submissions: { notPersonal: "A proposed catalog edit; it describes a bottle, and the submitter is already covered by the account bullet." },
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
