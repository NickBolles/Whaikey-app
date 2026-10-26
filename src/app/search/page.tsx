"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus, Search as SearchIcon } from "lucide-react";
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
  const trimmed = query.trim();
  // "It's not in there" is an ordinary answer for a catalog this size, so the
  // way to add it rides with the results — not only behind a zero-result
  // dead end (owner direction 2026-10-26). Prefilled from the query; the add
  // form runs the duplicate check before anything is created.
  const addHref = `/bottles/new?source=search${trimmed ? `&name=${encodeURIComponent(trimmed)}` : ""}`;
  const showAddWithResults = !isBrowsing && !error && results !== null && results.length > 0;

  return (
    <div className="px-3 pt-4 pb-6 flex flex-col gap-4">
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

      {showAddWithResults && (
        <AddThisBottle href={addHref} query={trimmed} placement="top" />
      )}

      {error && (
        <p role="alert" className="card-flat p-4 text-sm text-muted">
          {error}
        </p>
      )}

      {!error && results !== null && results.length === 0 && !loading && (
        <div className="flex flex-col gap-3">
          <div>
            <p className="font-display text-lg font-semibold">No bottles found</p>
            <p className="text-sm text-muted">
              Try fewer or shorter words — &quot;eagle&quot; instead of &quot;eagle rare bourbon&quot;
              {category ? ", or clear the category filter" : ""}.
            </p>
          </div>
          {/*
            A search that finds nothing used to end here (review PLAN-A1).
            "Not in there" is an ordinary answer, so the ordinary answer needs
            somewhere to go — the same Add block that rides with results.
          */}
          {trimmed ? (
            <AddThisBottle href={addHref} query={trimmed} placement="top" />
          ) : (
            <Link
              href={addHref}
              className="btn-primary flex min-h-12 items-center justify-center gap-2 px-4 text-[15px]"
            >
              <Plus size={18} strokeWidth={2.2} aria-hidden />
              Add a bottle
            </Link>
          )}
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setCategory(null);
            }}
            className="btn-secondary min-h-11 self-center px-5 text-sm font-medium"
          >
            Start over
          </button>
        </div>
      )}

      {!error && results !== null && results.length > 0 && (
        <section aria-label="Search results">
          {isBrowsing && <h2 className="section-label mb-3">Popular bottles</h2>}
          {!isBrowsing && (
            <h2 className="section-label mb-2">
              {results.length === 1 ? "1 close match" : `${results.length} close matches`}
            </h2>
          )}
          <ul className={`flex flex-col gap-2.5 ${loading ? "opacity-60" : ""}`}>
            {results.map((b) => (
              <li key={b.id}>
                <BottleCard bottle={b} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {showAddWithResults && <AddThisBottle href={addHref} query={trimmed} placement="end" />}

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

/**
 * The "Add this bottle" action that rides with search results: a framed
 * block above the list and a closing button under it, both one tap into the
 * add form with the query already filled in. 48px tall — the owner wanted it
 * big and obvious, and it is the thing people reach for at a distillery
 * whose bottles the catalog has never seen.
 */
function AddThisBottle({ href, query, placement }: { href: string; query: string; placement: "top" | "end" }) {
  if (placement === "top") {
    return (
      <section
        aria-label="Add this bottle"
        className="rounded-xl border-[1.5px] border-accent/70 bg-accent/[0.06] p-3"
      >
        <p className="kicker">Not in the list?</p>
        <p className="mt-0.5 font-display text-base font-semibold leading-snug break-words">
          Add &ldquo;{query}&rdquo;
        </p>
        <p className="text-xs text-muted">Name filled in from your search · we check for duplicates first.</p>
        <Link
          href={href}
          className="btn-primary mt-2.5 flex min-h-12 w-full items-center justify-center gap-2 px-4 text-[15px]"
        >
          <Plus size={18} strokeWidth={2.2} aria-hidden />
          Add this bottle
        </Link>
      </section>
    );
  }
  return (
    <div className="rule-double border-t-[3px] pt-3 text-center">
      <p className="text-xs text-muted">Still not it?</p>
      <Link
        href={href}
        className="btn-primary mt-2 flex min-h-12 w-full items-center justify-center gap-2 px-4 text-[15px]"
      >
        <Plus size={18} strokeWidth={2.2} aria-hidden />
        <span className="truncate">Add &ldquo;{query}&rdquo;</span>
      </Link>
    </div>
  );
}
