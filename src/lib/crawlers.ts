/**
 * Who `/robots.txt` speaks to (docs/TOS_DATA_REUSE.md, DRAFT — owner + legal review).
 *
 * robots.txt is a request, not a lock: well-behaved crawlers honour it, and the
 * Terms ("Using the catalog") are what make ignoring it a breach. The real
 * brake on bulk copying is the rate limit, not this file.
 *
 * OWNER DECISION (default below): crawlers that collect pages to TRAIN AI
 * models are disallowed everywhere; ordinary search engines may index the
 * public pages (the policies, credits, support). Search/answer bots that fetch
 * a page because a person asked about it (ChatGPT-User, OAI-SearchBot,
 * PerplexityBot, Claude-User/Claude-SearchBot) are NOT in this list — blocking
 * them hides Caskfolk from AI search without stopping training. Move them in
 * here if the owner prefers to block them too.
 */
export const AI_TRAINING_CRAWLERS = [
  "GPTBot", // OpenAI training
  "ClaudeBot", // Anthropic training
  "anthropic-ai", // Anthropic (legacy token)
  "CCBot", // Common Crawl — the corpus most models are trained on
  "Google-Extended", // Gemini / Vertex training opt-out token (does not affect Google Search)
  "Applebot-Extended", // Apple Intelligence training opt-out token (does not affect Applebot search)
  "meta-externalagent", // Meta AI training
  "FacebookBot", // Meta (legacy AI crawler)
  "Bytespider", // ByteDance
  "Amazonbot", // Amazon (AI + Alexa)
  "cohere-ai",
  "cohere-training-data-crawler",
  "Diffbot",
  "Timpibot",
  "ImagesiftBot",
  "omgili",
  "omgilibot",
  "PetalBot",
] as const;

/**
 * Paths no crawler — search engine or otherwise — should fetch.
 *
 * - `/api/` is the JSON the app talks to; catalog search returns a whole
 *   flavour profile per hit, which is exactly the bulk-copy surface.
 * - `/admin/` is operator-only (404 without auth) — listed so nobody probes it.
 * - `/s/`, `/u/`, `/o/`, `/f/` carry people's notes, profiles, outings and
 *   flights. Nothing is public by default, and a share link is a bearer
 *   credential; it should never land in a search index because somebody
 *   pasted it on a public page. OWNER DECISION: open `/u/` if public profiles
 *   should be findable on Google.
 */
export const DISALLOWED_FOR_ALL = ["/api/", "/admin/", "/s/", "/u/", "/o/", "/f/"] as const;
