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
    <div className="px-4 pt-6 flex flex-col gap-5">
      <header>
        <h1 className="font-display text-[2rem] leading-tight font-semibold">Find a bottle</h1>
        <p className="text-muted text-sm mt-1">Search by bottle, distillery, or nickname.</p>
      </header>

      <div className="relative">
        <SearchIcon
          size={18}
          strokeWidth={1.8}
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
          className="w-full rounded-xl border border-border-subtle bg-surface py-3 pl-10 pr-4 text-foreground placeholder:text-muted transition-colors focus:outline-none focus:border-accent/70"
        />
      </div>

      <div
        className="-mx-4 px-4 flex gap-2 overflow-x-auto pb-1"
        role="tablist"
        aria-label="Filter by category"
      >
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
        <p role="alert" className="card-flat p-4 text-sm text-muted">
          {error}
        </p>
      )}

      {!error && results !== null && results.length === 0 && !loading && (
        <div className="card p-8 text-center flex flex-col items-center gap-2">
          <div aria-hidden className="text-4xl mb-1">
            🥃
          </div>
          <p className="font-display text-lg font-semibold">No bottles found</p>
          <p className="text-sm text-muted leading-relaxed max-w-xs">
            Try fewer or shorter words — &quot;eagle&quot; instead of &quot;eagle rare bourbon&quot;
            {category ? ", or clear the category filter" : ""}.
          </p>
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setCategory(null);
            }}
            className="btn-secondary mt-3 px-5 py-2.5 text-sm font-medium"
          >
            Start over
          </button>
        </div>
      )}

      {!error && results !== null && results.length > 0 && (
        <section aria-label="Search results">
          {isBrowsing && <h2 className="section-label mb-3">Popular bottles</h2>}
          <ul className={`flex flex-col gap-2.5 ${loading ? "opacity-60" : ""}`}>
            {results.map((b) => (
              <li key={b.id}>
                <BottleCard bottle={b} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {results === null && loading && !error && (
        <p role="status" className="text-sm text-muted text-center py-8">Loading the shelf…</p>
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
      className={`chip shrink-0 min-h-11 px-4 text-sm font-medium whitespace-nowrap ${
        active ? "chip-active" : "hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );
}
