import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight, ScanLine, Search, Sparkles } from "lucide-react";
import { getSessionUser } from "@/lib/session";
import { isAiConfigured } from "@/lib/ai/client";
import { RecommendationRail } from "@/components/recommendation-rail";
import { DiscoverChips, DiscoverLearn, DiscoverMenuHint } from "./discover-client";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Discover",
  description: "Ask the concierge, learn whiskey, and find any bottle.",
};

/** Suggested questions for the Ask prompt; each opens the concierge with it. */
const SUGGESTED_QUESTIONS = [
  "What should I open for a rainy night?",
  "Why is Islay whisky smoky?",
  "What does bottled-in-bond mean?",
  "What's my bar missing?",
] as const;

/**
 * Discover (STORYBOARD D10, amended 2026-11-02; board
 * caskfolk-discover-20261102 V1): one scrolling hub — Ask, Learn, Find —
 * with a chip row that jumps between them. The bottom-nav quick menu (hold
 * or tap Discover again) is the shortcut into the same places.
 */
export default async function DiscoverPage() {
  const user = await getSessionUser();
  const ai = Boolean(user) && isAiConfigured();
  const sections = [...(ai ? [{ id: "ask", label: "Ask" }] : []), { id: "learn", label: "Learn" }, { id: "find", label: "Find" }];

  return (
    <div className="flex flex-col gap-6 pb-4">
      <DiscoverChips sections={sections} />
      <header className="px-4">
        <p className="section-label">Discover</p>
        <h1 className="font-display text-[1.75rem] leading-tight font-semibold">Find, ask, learn</h1>
      </header>

      {ai && (
        <section id="ask" aria-labelledby="discover-ask" className="mx-4 scroll-mt-16 card p-4">
          <div className="flex items-baseline justify-between gap-2">
            <h2 id="discover-ask" className="section-label">
              Ask the concierge
            </h2>
            <span className="text-xs text-muted">about your bar</span>
          </div>
          <form action="/chat" method="get" className="mt-3 flex items-center gap-2 rounded-lg border border-border bg-background pl-3 pr-1">
            <Sparkles size={17} strokeWidth={1.8} className="shrink-0 text-accent" aria-hidden />
            <label htmlFor="discover-ask-input" className="sr-only">
              Ask anything about whiskey
            </label>
            <input
              id="discover-ask-input"
              name="q"
              required
              maxLength={1000}
              placeholder="Ask anything about whiskey…"
              className="min-h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
            />
            <button type="submit" className="btn-secondary tap-target h-9 px-3 text-sm">
              Ask
            </button>
          </form>
          <ul aria-label="Suggested questions" className="mt-3 flex flex-wrap gap-2 py-1">
            {SUGGESTED_QUESTIONS.map((q) => (
              <li key={q}>
                <Link href={`/chat?q=${encodeURIComponent(q)}`} className="chip tap-target inline-flex text-xs">
                  {q}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section id="learn" aria-labelledby="discover-learn" className="mx-4 scroll-mt-16 flex flex-col gap-2.5">
        <h2 id="discover-learn" className="section-label">
          Learn · Whiskey School
        </h2>
        <DiscoverLearn />
      </section>

      <section id="find" aria-labelledby="discover-find" className="scroll-mt-16 flex flex-col gap-2.5">
        <h2 id="discover-find" className="section-label mx-4">
          Find
        </h2>
        <div className="mx-4 flex items-stretch gap-2">
          <Link
            href="/search"
            className="flex min-h-11 flex-1 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-sm text-muted hover:text-foreground"
          >
            <Search size={17} strokeWidth={1.8} aria-hidden />
            Search bottles
            <ChevronRight size={16} strokeWidth={1.8} className="ml-auto" aria-hidden />
          </Link>
          <Link href="/scan" className="btn-secondary inline-flex min-h-11 items-center gap-1.5 px-3 text-sm">
            <ScanLine size={17} strokeWidth={1.8} aria-hidden />
            Scan
          </Link>
        </div>
        {user && <RecommendationRail mode="discovery" title="Try something new" subtitle="New bottles that fit what you rate highly." />}
      </section>

      {user && <DiscoverMenuHint />}
    </div>
  );
}
