"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronUp, CloudOff, GlassWater, ScanLine, Search, Star } from "lucide-react";
import { SERVING_STYLES, type PourVisibility, type ServingStyle } from "@/db/schema";
import { StarRating } from "@/components/star-rating";
import { FlavorWheelInput } from "@/components/flavor-wheel-input";
import { NoteCapture, type ExtractedTastingNote } from "@/components/note-capture";
import { VisibilityChips } from "@/components/visibility-chips";
import { enqueuePour } from "@/lib/native/offline-queue";

export interface BottlePick {
  id: string;
  name: string;
  distillery?: string | null;
  category?: string | null;
}

interface SearchResult {
  id: string;
  name: string;
  distillery?: string | { name?: string } | null;
  category?: string | null;
}

const POUR_SIZES = [30, 45, 60] as const;

function distilleryName(d: SearchResult["distillery"]): string | null {
  if (!d) return null;
  if (typeof d === "string") return d;
  return d.name ?? null;
}

// ---------------------------------------------------------------------------
// Step 1: bottle picker
// ---------------------------------------------------------------------------

function BottlePicker({ onPick }: { onPick: (bottle: BottlePick) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [recent, setRecent] = useState<BottlePick[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Recent bottles from the user's pour history — one-tap re-log.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/pours?limit=20")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { pours?: Array<{ bottleId: string; bottleName: string }> } | null) => {
        if (cancelled || !data?.pours) return;
        const seen = new Set<string>();
        const unique: BottlePick[] = [];
        for (const p of data.pours) {
          if (seen.has(p.bottleId)) continue;
          seen.add(p.bottleId);
          unique.push({ id: p.bottleId, name: p.bottleName });
          if (unique.length >= 5) break;
        }
        setRecent(unique);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const runSearch = useCallback((q: string) => {
    setSearching(true);
    setSearchError(false);
    fetch(`/api/bottles/search?q=${encodeURIComponent(q)}`)
      .then((res) => {
        if (!res.ok) throw new Error("search failed");
        return res.json();
      })
      .then((data: { results?: SearchResult[] }) => {
        setResults(Array.isArray(data?.results) ? data.results : []);
      })
      .catch(() => {
        setResults([]);
        setSearchError(true);
      })
      .finally(() => setSearching(false));
  }, []);

  // Clear any pending debounce on unmount.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const handleQueryChange = (next: string) => {
    setQuery(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = next.trim();
    if (q.length < 2) {
      setResults([]);
      setSearchError(false);
      return;
    }
    debounceRef.current = setTimeout(() => runSearch(q), 250);
  };

  return (
    <div className="flex flex-col gap-5">
      <label className="relative block">
        <span className="sr-only">Search bottles</span>
        <Search
          size={18}
          strokeWidth={1.8}
          className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted"
          aria-hidden
        />
        <input
          type="search"
          autoFocus
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          placeholder="What are you pouring?"
          className="w-full rounded-xl bg-surface border border-border-subtle pl-11 pr-4 py-3 placeholder:text-muted focus:outline-none focus:border-accent"
        />
      </label>

      {/* Scanning is the fastest way to pick a bottle you're holding, so it
          sits with the search box rather than only on the shelf-building page. */}
      <Link
        href="/scan?then=pour"
        className="card-flat flex items-center gap-3 p-4 hover:bg-surface-raised transition-colors"
      >
        <ScanLine size={18} strokeWidth={1.8} className="text-accent shrink-0" aria-hidden />
        <span className="flex-1 min-w-0">
          <span className="font-medium block">Scan the bottle</span>
          <span className="text-xs text-muted">Barcode or label — faster than typing.</span>
        </span>
      </Link>

      {searchError && (
        <p className="card-flat text-sm text-muted p-4">
          Search is unavailable right now — try again in a moment, or pick from your recent
          bottles below.
        </p>
      )}

      {searching && <p role="status" className="text-sm text-muted px-1">Searching…</p>}

      {results.length > 0 && (
        <ul className="flex flex-col gap-2.5" aria-label="Search results">
          {results.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() =>
                  onPick({
                    id: r.id,
                    name: r.name,
                    distillery: distilleryName(r.distillery),
                    category: r.category,
                  })
                }
                className="card-flat w-full text-left p-4 hover:bg-surface-raised transition-colors"
              >
                <span className="font-medium block">{r.name}</span>
                <span className="text-xs text-muted">
                  {[distilleryName(r.distillery), r.category].filter(Boolean).join(" · ")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {query.trim().length >= 2 && !searching && !searchError && results.length === 0 && (
        <p className="text-sm text-muted px-1">No bottles match “{query.trim()}”.</p>
      )}

      {recent.length > 0 && (
        <section aria-label="Recent bottles">
          <h2 className="section-label mb-3">Recent bottles</h2>
          <ul className="flex flex-col gap-2.5">
            {recent.map((b) => (
              <li key={b.id}>
                <button
                  type="button"
                  onClick={() => onPick(b)}
                  className="card-flat w-full flex items-center gap-3 text-left p-4 hover:bg-surface-raised transition-colors"
                >
                  <GlassWater size={18} strokeWidth={1.8} className="text-accent shrink-0" aria-hidden />
                  <span className="font-medium">{b.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

export function PourFlow({ initialBottle = null, initialBottleMissing = false }: { initialBottle?: BottlePick | null; initialBottleMissing?: boolean }) {
  const [bottle, setBottle] = useState<BottlePick | null>(initialBottle);
  const [rating, setRating] = useState<number | null>(null);
  const [servingStyle, setServingStyle] = useState<ServingStyle | null>(null);
  const [amountMl, setAmountMl] = useState<number>(45);
  const [notesOpen, setNotesOpen] = useState(true);
  const [nose, setNose] = useState("");
  const [palate, setPalate] = useState("");
  const [finish, setFinish] = useState("");
  const [freeform, setFreeform] = useState("");
  const [flavorTags, setFlavorTags] = useState<Record<string, number>>({});
  const [visibility, setVisibility] = useState<PourVisibility>("private");
  // The user's saved default, so "Log another" starts fresh instead of
  // silently inheriting a previous pour's one-off visibility choice.
  const [defaultVisibility, setDefaultVisibility] = useState<PourVisibility>("private");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [done, setDone] = useState<{
    bottleName: string;
    rating: number | null;
    /** Saved locally because the network was gone; it syncs on reconnect. */
    queued: boolean;
  } | null>(null);

  // US-6: the visibility selector defaults to the user's saved preference,
  // never a new tap — a failed/401 fetch just leaves it at "Only me".
  useEffect(() => {
    let cancelled = false;
    fetch("/api/social/prefs")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { defaultPourVisibility?: PourVisibility } | null) => {
        if (!cancelled && data?.defaultPourVisibility) {
          setVisibility(data.defaultPourVisibility);
          setDefaultVisibility(data.defaultPourVisibility);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const reset = () => {
    setBottle(null);
    setRating(null);
    setServingStyle(null);
    setAmountMl(45);
    setNotesOpen(true);
    setNose("");
    setPalate("");
    setFinish("");
    setFreeform("");
    setFlavorTags({});
    setVisibility(defaultVisibility);
    setSubmitting(false);
    setSubmitError(null);
    setDone(null);
  };

  // Merge an AI extraction into the user's in-progress note WITHOUT clobbering
  // anything they've already entered. Extraction assists; the user stays author.
  const applyExtraction = (r: ExtractedTastingNote) => {
    if (r.nose && !nose.trim()) setNose(r.nose);
    if (r.palate && !palate.trim()) setPalate(r.palate);
    if (r.finish && !finish.trim()) setFinish(r.finish);
    if (Object.keys(r.flavorTags).length > 0) {
      setFlavorTags((cur) => ({ ...r.flavorTags, ...cur }));
    }
    // Anything that landed in the collapsed section is opened for review —
    // applied values the user can't see are values they can't correct.
    const filledDetails =
      (r.nose && !nose.trim()) ||
      (r.palate && !palate.trim()) ||
      (r.finish && !finish.trim()) ||
      Object.keys(r.flavorTags).length > 0;
    if (filledDetails) setNotesOpen(true);
    if (r.suggestedRating != null && rating == null) setRating(r.suggestedRating);
    if (
      r.servingStyle &&
      servingStyle == null &&
      (SERVING_STYLES as readonly string[]).includes(r.servingStyle)
    ) {
      setServingStyle(r.servingStyle as ServingStyle);
    }
  };

  const submit = async () => {
    if (!bottle || submitting) return;
    setSubmitting(true);
    setSubmitError(null);

    const noteFields = {
      nose: nose.trim() || undefined,
      palate: palate.trim() || undefined,
      finish: finish.trim() || undefined,
      freeform: freeform.trim() || undefined,
      flavorTags: Object.keys(flavorTags).length > 0 ? flavorTags : undefined,
    };
    const hasNote = Object.values(noteFields).some((v) => v !== undefined);

    const payload = {
      bottleId: bottle.id,
      rating: rating ?? undefined,
      servingStyle: servingStyle ?? undefined,
      amountMl,
      note: hasNote ? noteFields : undefined,
      visibility,
    };

    try {
      const res = await fetch("/api/pours", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "Something went wrong saving your pour.");
      }
      setDone({ bottleName: bottle.name, rating, queued: false });
    } catch (err) {
      // A pour is logged where the whiskey is, and that is routinely somewhere
      // with no signal (PLAN.md §4.2). Losing the note the user just wrote is a
      // far worse outcome than a delayed save, so a network failure queues it
      // instead of erroring. A server that answered and said no is a real error.
      if (err instanceof TypeError) {
        await enqueuePour({ body: payload, bottleName: bottle.name });
        setDone({ bottleName: bottle.name, rating, queued: true });
      } else {
        setSubmitError(err instanceof Error ? err.message : "Something went wrong.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[70dvh] px-6 text-center gap-7">
        <div aria-hidden className="text-6xl drop-shadow-[0_0_24px_rgba(232,161,60,0.25)]">
          🥃
        </div>
        <div>
          <h1 className="font-display text-5xl font-semibold tracking-tight text-gradient-amber">
            Poured.
          </h1>
          <p className="text-muted mt-3">{done.bottleName}</p>
          {done.rating != null && (
            <p className="mt-2.5 flex items-center justify-center gap-1.5 text-accent">
              <Star size={16} fill="currentColor" aria-hidden />
              <span className="stat-number text-2xl leading-none">{done.rating.toFixed(1)}</span>
            </p>
          )}
          {done.queued && (
            // Reassurance, not an error: the pour is saved on the device and
            // goes up on its own. Nothing for the user to do or remember.
            <p role="status" className="text-sm text-muted mt-4 flex items-center justify-center gap-2">
              <CloudOff size={15} strokeWidth={1.8} aria-hidden />
              Saved on your phone — it&apos;ll sync when you&apos;re back online.
            </p>
          )}
        </div>
        <div className="flex gap-3">
          <button type="button" onClick={reset} className="btn-primary px-7 py-3">
            Log another
          </button>
          <Link href="/history" className="btn-secondary px-7 py-3 font-medium">
            View journal
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 pt-8 pb-24 flex flex-col gap-6 max-w-lg mx-auto">
      <header>
        <h1 className="font-display text-[2rem] leading-tight font-semibold">Log a pour</h1>
        <p className="text-muted text-sm mt-1">
          {bottle ? "How was it?" : "Pick a bottle to get started."}
        </p>
      </header>

      {!bottle ? (
        <>
          {initialBottleMissing && <p role="alert" className="rounded-xl border border-danger/40 bg-danger/10 p-3 text-sm text-danger">We couldn’t load that bottle. Pick one below instead.</p>}
          <BottlePicker onPick={setBottle} />
        </>
      ) : (
        <div className="flex flex-col gap-6">
          <div className="card flex items-center justify-between p-4">
            <div>
              <div className="font-medium">{bottle.name}</div>
              {(bottle.distillery || bottle.category) && (
                <div className="text-xs text-muted mt-0.5">
                  {[bottle.distillery, bottle.category].filter(Boolean).join(" · ")}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => setBottle(null)}
              className="text-sm text-accent shrink-0 ml-3 min-h-11 px-1 hover:brightness-110 transition-[filter]"
            >
              Change
            </button>
          </div>

          {/* Speak first, correct after. This sits above the form because
              dictating a note can fill most of what's below it — burying it in
              the collapsed section made the app look like a form to type into. */}
          <section aria-label="Capture your note" className="card flex flex-col gap-3 p-4">
            <NoteCapture
              freeform={freeform}
              onFreeformChange={setFreeform}
              onApplyExtraction={applyExtraction}
              label="Say what you taste"
              placeholder="“Loads of vanilla and charred oak, long warm finish — about a four.”"
              hint="Auto-fill turns your words into a rating, flavors, and nose/palate/finish. You can edit everything after."
            />
          </section>

          <section aria-label="Rating" className="flex flex-col gap-3">
            <h2 className="section-label">Rating</h2>
            <StarRating value={rating} onChange={setRating} />
          </section>

          <section aria-label="Serving style" className="flex flex-col gap-3">
            <h2 className="section-label">Serving</h2>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Serving style">
              {SERVING_STYLES.map((style) => (
                <button
                  key={style}
                  type="button"
                  aria-pressed={servingStyle === style}
                  onClick={() => setServingStyle((cur) => (cur === style ? null : style))}
                  className={`chip min-h-11 px-4 text-sm capitalize ${
                    servingStyle === style ? "chip-active font-medium" : "hover:bg-surface-raised"
                  }`}
                >
                  {style}
                </button>
              ))}
            </div>
            <div className="flex gap-2" role="group" aria-label="Pour size">
              {POUR_SIZES.map((ml) => (
                <button
                  key={ml}
                  type="button"
                  aria-pressed={amountMl === ml}
                  onClick={() => setAmountMl(ml)}
                  className={`chip min-h-11 px-4 text-sm ${
                    amountMl === ml ? "chip-active font-medium" : "hover:bg-surface-raised"
                  }`}
                >
                  {ml} ml
                </button>
              ))}
            </div>
          </section>

          <section aria-label="Tasting notes" className="flex flex-col gap-3">
            <button
              type="button"
              onClick={() => setNotesOpen((o) => !o)}
              aria-expanded={notesOpen}
              className="card flex items-center justify-between p-4 hover:brightness-110 transition-[filter]"
            >
              <span className="font-medium text-sm">
                Tasting notes <span className="text-muted font-normal">(optional)</span>
              </span>
              {notesOpen ? (
                <ChevronUp size={18} strokeWidth={1.8} className="text-muted" aria-hidden />
              ) : (
                <ChevronDown size={18} strokeWidth={1.8} className="text-muted" aria-hidden />
              )}
            </button>

            {notesOpen && (
              <div className="flex flex-col gap-4">
                {(
                  [
                    ["Nose", nose, setNose],
                    ["Palate", palate, setPalate],
                    ["Finish", finish, setFinish],
                  ] as const
                ).map(([label, val, set]) => (
                  <label key={label} className="flex flex-col gap-1.5">
                    <span className="section-label">{label}</span>
                    <textarea
                      value={val}
                      onChange={(e) => set(e.target.value)}
                      rows={2}
                      placeholder={
                        label === "Nose"
                          ? "What do you smell?"
                          : label === "Palate"
                            ? "What do you taste?"
                            : "How does it linger?"
                      }
                      className="rounded-xl bg-surface border border-border-subtle p-3 text-sm placeholder:text-muted focus:outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-accent/60 resize-y"
                    />
                  </label>
                ))}

                <div className="flex flex-col gap-1.5">
                  <span className="section-label">Flavor wheel</span>
                  <FlavorWheelInput value={flavorTags} onChange={setFlavorTags} />
                </div>

                <div className="flex flex-col gap-1.5">
                  <span className="section-label">Who can see this</span>
                  <VisibilityChips value={visibility} onChange={setVisibility} idPrefix="pour-visibility" />
                </div>
              </div>
            )}
          </section>

          {submitError && (
            <p role="alert" className="text-sm text-danger rounded-xl border border-danger/40 bg-surface p-3">
              {submitError}
            </p>
          )}

          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            className="btn-primary w-full py-3.5 text-base disabled:opacity-60"
          >
            {submitting ? "Saving…" : "Save pour"}
          </button>
        </div>
      )}
    </div>
  );
}
