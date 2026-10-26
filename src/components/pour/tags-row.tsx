"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { MAX_TAGS_PER_POUR, cleanTag, tagKey } from "@/lib/tags-client";

/**
 * The pour sheet's tags row: the pour's tags (tap to remove), suggestions from
 * the user's own history (tap to add), and "+ Tag" for a new one. Tags are
 * private to their author; nothing here is ever shown to anyone else.
 */
export function TagsRow({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/tags")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { tags?: Array<{ name: string }> } | null) => {
        if (!cancelled && data?.tags) setSuggestions(data.tags.map((t) => t.name));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  const keys = new Set(value.map(tagKey));
  const full = value.length >= MAX_TAGS_PER_POUR;

  /** Adds every given tag in one change (a pasted "blind, gift" is two). */
  function addAll(raws: string[]) {
    const next = [...value];
    const seen = new Set(next.map(tagKey));
    for (const raw of raws) {
      const name = cleanTag(raw);
      if (!name || seen.has(tagKey(name)) || next.length >= MAX_TAGS_PER_POUR) continue;
      seen.add(tagKey(name));
      next.push(name);
    }
    if (next.length !== value.length) onChange(next);
  }

  const add = (raw: string) => addAll([raw]);

  function commitDraft() {
    addAll(draft.split(","));
    setDraft("");
  }

  const offered = suggestions.filter((s) => !keys.has(tagKey(s))).slice(0, 6);

  return (
    <section aria-label="Tags" className="flex flex-col gap-1.5">
      <span className="section-label">Tags</span>
      <ul className="flex flex-wrap gap-1.5">
        {value.map((tag) => (
          <li key={tagKey(tag)}>
            <button
              type="button"
              aria-label={`Remove tag ${tag}`}
              onClick={() => onChange(value.filter((t) => tagKey(t) !== tagKey(tag)))}
              className="chip chip-active flex min-h-11 items-center gap-1 px-3 text-xs font-medium"
            >
              #{tag} <X size={12} strokeWidth={2} aria-hidden />
            </button>
          </li>
        ))}
        {!full &&
          offered.map((tag) => (
            <li key={`s-${tagKey(tag)}`}>
              <button
                type="button"
                aria-label={`Add tag ${tag}`}
                onClick={() => add(tag)}
                className="chip min-h-11 px-3 text-xs text-foreground/80 hover:bg-surface-raised"
              >
                #{tag}
              </button>
            </li>
          ))}
        {!full && !adding && (
          <li>
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="chip flex min-h-11 items-center gap-1 px-3 text-xs text-muted hover:bg-surface-raised"
            >
              <Plus size={12} strokeWidth={2} aria-hidden /> Tag
            </button>
          </li>
        )}
      </ul>
      {adding && !full && (
        <label className="flex items-center gap-2">
          <span className="sr-only">New tag</span>
          <input
            ref={inputRef}
            value={draft}
            maxLength={64}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                commitDraft();
              } else if (e.key === "Escape") {
                setDraft("");
                setAdding(false);
              }
            }}
            onBlur={() => {
              commitDraft();
              setAdding(false);
            }}
            placeholder="tasting night, gift…"
            className="h-11 min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 text-sm placeholder:text-muted focus:border-accent focus:outline-none"
          />
        </label>
      )}
    </section>
  );
}
