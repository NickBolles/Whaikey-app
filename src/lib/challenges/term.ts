/**
 * What the product calls a breadth challenge (docs/SOCIAL.md D23).
 *
 * The owner, 2026-10-26: "Challenges" sounds like we're challenging you to
 * drink more. The mechanic never was that — it counts different things met,
 * never how much (§7.12) — so the word now says so. Every user-facing name for
 * it comes from this one constant; to rename again, change it here (and, if
 * you want the URL to follow, move `src/app/trails` and keep a redirect).
 *
 * Shortlisted, all framing exploration rather than consumption:
 * - **Trails** (chosen) — whiskey's own word for a route of discovery (the
 *   Kentucky Bourbon Trail, the Malt Whisky Trail); you follow one, you don't
 *   win it, and it sits naturally beside outings and the passport.
 * - Expeditions — bigger, adventurous; reads as rarer, longer journeys.
 * - Field Guides — learning-first and calm; less sense of finishing.
 * - Explorations — the plainest statement of the stance; a bit abstract.
 * - Passport Stamps — ties straight to the passport, but blurs with crests.
 * - Quests — playful, but game-ier, and closest to "challenge" in tone.
 *
 * Internals (tables, API routes, rule kinds) keep the `challenge` name: they
 * are not user-facing, and renaming them would cost a migration for nothing.
 */
export const TRAIL = {
  one: "Trail",
  many: "Trails",
  lower: "trail",
  lowerMany: "trails",
  /** The page. `/challenges` redirects here. */
  path: "/trails",
} as const;
