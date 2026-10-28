import type { MetadataRoute } from "next";
import { AI_TRAINING_CRAWLERS, DISALLOWED_FOR_ALL } from "@/lib/crawlers";

/**
 * `/robots.txt` (DRAFT — owner + legal review; see src/lib/crawlers.ts for the
 * defaults and the decisions behind them). Search engines may read the public
 * pages; AI-training crawlers may read nothing; nobody should crawl the API or
 * people's shared notes.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: [...AI_TRAINING_CRAWLERS], disallow: "/" },
      { userAgent: "*", allow: "/", disallow: [...DISALLOWED_FOR_ALL] },
    ],
  };
}
