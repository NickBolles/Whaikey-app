import { describe, expect, it } from "vitest";
import { NOTIFICATION_CATEGORIES } from "@/db/schema";
import { BANNED_NOTIFICATION_PHRASES, NOTIFICATION_GROUPS, groupFor, renderNotification } from "./copy";

/**
 * The banned-copy test (docs/SOCIAL.md D18, whiskey-build-tracks C6): every
 * template, in every variant, rendered and searched for the vocabulary of a
 * nudge — pouring, cadence, loss. A notification may only say that somebody
 * did something with you.
 */
const VARIANTS: Array<Record<string, string>> = [
  {},
  { event: "invite" },
  { event: "joined" },
  { event: "revealed" },
  { event: "completed" },
  { event: "recap" },
  { event: "invite", outingTitle: "Saturday at Buffalo Trace", distillery: "Buffalo Trace" },
  { event: "recap", outingTitle: "Saturday at Buffalo Trace", distillery: "Buffalo Trace" },
  { relationship: "wishlist", bottleName: "Test Bottle", pourId: "p" },
  { relationship: "own", bottleName: "Test Bottle", pourId: "p" },
  { clubName: "Tuesday Drams", flightTitle: "Islay night", challengeTitle: "Around the world", slug: "around-the-world" },
];

describe("notification copy", () => {
  const rendered = NOTIFICATION_CATEGORIES.flatMap((category) =>
    VARIANTS.flatMap((data) =>
      [null, "sasha"].map((actorHandle) => ({ category, ...renderNotification({ category, actorHandle, subjectId: "x1", data }) })),
    ),
  );

  it("never uses banned phrases", () => {
    for (const r of rendered) {
      const text = r.text.toLowerCase();
      for (const phrase of BANNED_NOTIFICATION_PHRASES) {
        expect(text, `${r.category}: "${r.text}"`).not.toContain(phrase);
      }
    }
  });

  it("deep-links to a same-origin path", () => {
    for (const r of rendered) expect(r.deepLink, r.category).toMatch(/^\/[a-z]/);
  });

  it("puts every category in exactly one settings group", () => {
    for (const category of NOTIFICATION_CATEGORIES) {
      expect(NOTIFICATION_GROUPS.filter((g) => (g.categories as readonly string[]).includes(category))).toHaveLength(1);
      expect(groupFor(category)).toBeDefined();
    }
  });
});
