"use client";

import { useEffect, useState } from "react";
import { Search as SearchIcon } from "lucide-react";
import { WHISKEY_CATEGORIES } from "@/db/schema";
import { BottleCard } from "@/components/bottle-card";
import { categoryLabel } from "@/components/category-chip";
import type { BottleSearchResult } from "@/lib/search";

const DEBOUNCE_MS = 200;

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [results, setResults] = useState<BottleSearchResult[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (query.trim()) params.set("q", query.trim());
        if (category) params.set("category", category);
        const res = await fetch(`/api/bottles/search?${params.toString()}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`Search failed (${res.status})`);
        const data = (await res.json()) as { results: BottleSearchResult[] };
        setResults(data.results);
        setLoading(false);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError("Something went wrong searching the catalog. Try again.");
        setResults([]);
        setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, category]);

  const isBrowsing = query.trim().length === 0;

  return (
    <div className="px-4 pt-6 flex flex-col gap-4">
      <header>
        <h1 className="text-2xl font-bold">Find a bottle</h1>
        <p className="text-muted text-sm mt-1">Search by bottle, distillery, or nickname.</p>
      </header>

      <div className="relative">
        <SearchIcon
          size={18}
          aria-hidden
          className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted"
        />
        <input
          autoFocus
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder='Try "eagle 10" or "ECBP"'
          aria-label="Search bottles"
          className="w-full rounded-xl border border-border-subtle bg-surface py-3 pl-10 pr-4 text-foreground placeholder:text-muted focus:outline-none focus:border-accent"
        />
      </div>

      <div className="-mx-4 px-4 flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Filter by category">
        <CategoryFilterChip
          label="All"
          active={category === null}
          onClick={() => setCategory(null)}
        />
        {WHISKEY_CATEGORIES.map((c) => (
          <CategoryFilterChip
            key={c}
            label={categoryLabel(c)}
            active={category === c}
            onClick={() => setCategory(category === c ? null : c)}
          />
        ))}
      </div>

      {error && (
        <p role="alert" className="rounded-xl border border-border-subtle bg-surface p-4 text-sm text-muted">
          {error}
        </p>
      )}

      {!error && results !== null && results.length === 0 && !loading && (
        <div className="rounded-xl border border-border-subtle bg-surface p-6 text-center">
          <p className="font-medium">No bottles found</p>
          <p className="text-sm text-muted mt-1">
            Try fewer or shorter words — &quot;eagle&quot; instead of &quot;eagle rare bourbon&quot;
            {category ? ", or clear the category filter" : ""}.
          </p>
        </div>
      )}

      {!error && results !== null && results.length > 0 && (
        <section aria-label="Search results">
          {isBrowsing && (
            <h2 className="text-sm font-semibold text-muted uppercase tracking-wide mb-2">
              Popular bottles
            </h2>
          )}
          <ul className={`flex flex-col gap-2 ${loading ? "opacity-60" : ""}`}>
            {results.map((b) => (
              <li key={b.id}>
                <BottleCard bottle={b} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {results === null && loading && !error && (
        <p className="text-sm text-muted text-center py-8">Loading the shelf…</p>
      )}
    </div>
  );
}

function CategoryFilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium border transition-colors whitespace-nowrap ${
        active
          ? "bg-accent text-background border-accent"
          : "bg-surface text-muted border-border-subtle hover:bg-surface-raised"
      }`}
    >
      {label}
    </button>
  );
}
