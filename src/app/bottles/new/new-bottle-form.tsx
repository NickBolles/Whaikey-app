"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { categoryLabel } from "@/components/category-chip";
import type { WhiskeyCategory } from "@/db/schema";

/**
 * The add-a-bottle form (review PLAN-A1).
 *
 * Two things it deliberately does not do. It does not ask for much: name and
 * category are the only required fields, because a form that demands an ABV
 * and a cask type before it will accept a bottle is a dead end wearing a
 * different hat. And it does not promise the catalog: the bottle is the
 * user's straight away, and the copy says plainly that everyone else sees it
 * once it has been reviewed.
 */

/** The shared input styling used across the app's forms (docs/DESIGN.md §Rules 1, 8). */
const INPUT =
  "w-full rounded-xl border border-border-subtle bg-surface py-3 px-4 text-foreground placeholder:text-muted transition-colors focus:outline-none focus:border-accent/70";

interface Duplicate {
  id: string;
  name: string;
  distillery: string | null;
  category: string;
}

export function NewBottleForm({
  categories,
  initialName,
  upc,
  source,
  returnTo,
}: {
  /**
   * Passed in rather than imported: `WHISKEY_CATEGORIES` lives in the Drizzle
   * schema module, and pulling that into a client bundle drags the whole
   * schema across the boundary for the sake of ten strings.
   */
  categories: readonly WhiskeyCategory[];
  initialName: string;
  upc: string | null;
  source: "scan" | "search" | "import" | "direct";
  returnTo: string | null;
}) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [category, setCategory] = useState<WhiskeyCategory>(categories[0]);
  const [distillery, setDistillery] = useState("");
  const [ageYears, setAgeYears] = useState("");
  const [abv, setAbv] = useState("");
  const [relationship, setRelationship] = useState<"own" | "tried" | "wishlist">("own");
  const [duplicates, setDuplicates] = useState<Duplicate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(confirmNew: boolean) {
    if (name.trim().length < 2) {
      setError("Give it a name — a couple of characters is enough.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/bottles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          category,
          distillery: distillery.trim() || undefined,
          ageYears: ageYears.trim() ? Number(ageYears) : undefined,
          abv: abv.trim() ? Number(abv) : undefined,
          upc: upc ?? undefined,
          source,
          relationship,
          confirmNew,
        }),
      });

      if (res.status === 409) {
        const data = (await res.json()) as { duplicates?: Duplicate[] };
        setDuplicates(data.duplicates ?? []);
        setSaving(false);
        return;
      }
      if (res.status === 429) {
        setError("That's a lot of new bottles at once — try again in a bit.");
        setSaving(false);
        return;
      }
      if (!res.ok) throw new Error(`add failed (${res.status})`);

      const data = (await res.json()) as { bottle: { id: string } };
      router.push(returnTo ?? `/bottles/${data.bottle.id}`);
      router.refresh();
    } catch {
      setError("Couldn't add that bottle. Check your connection and try again.");
      setSaving(false);
    }
  }

  return (
    <div className="px-4 py-6 flex flex-col gap-6 max-w-lg mx-auto w-full">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-2xl font-semibold">Add a bottle</h1>
        <p className="text-sm text-muted leading-relaxed">
          Not in the catalog? Add it and it&apos;s yours right away — pour it, shelve it, note
          it. It joins the shared catalog once someone has checked it over.
        </p>
      </header>

      {duplicates !== null && (
        <section
          className="card p-4 flex flex-col gap-3"
          aria-label="Possible matches already in the catalog"
        >
          <p className="text-sm leading-relaxed">
            {duplicates.length > 0
              ? "We may already have this one. Is it any of these?"
              : "Nothing matched — go ahead."}
          </p>
          <ul className="flex flex-col gap-2">
            {duplicates.map((b) => (
              <li key={b.id} className="card-flat flex items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <div className="font-medium truncate">{b.name}</div>
                  {b.distillery && (
                    <div className="text-xs text-muted truncate mt-0.5">{b.distillery}</div>
                  )}
                </div>
                <Link
                  href={`/bottles/${b.id}`}
                  className="btn-secondary shrink-0 px-3.5 py-2 text-xs font-medium"
                >
                  That&apos;s it
                </Link>
              </li>
            ))}
          </ul>
          <button
            type="button"
            disabled={saving}
            onClick={() => void submit(true)}
            className="btn-primary px-4 py-3 text-sm font-medium disabled:opacity-60"
          >
            None of these — add mine
          </button>
        </section>
      )}

      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(false);
        }}
      >
        <Field label="Bottle name" htmlFor="new-bottle-name" hint="Required">
          <input
            id="new-bottle-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              // The confirmation is about the name that was refused. Editing
              // the name and then pressing "add mine" would carry
              // `confirmNew` onto a different name, skipping the check for a
              // bottle we may well have.
              setDuplicates(null);
            }}
            autoFocus
            placeholder="Elijah Craig Barrel Proof B524"
            className={INPUT}
          />
        </Field>

        <fieldset className="flex flex-col gap-2">
          <legend className="section-label mb-1">Category</legend>
          <div className="flex flex-wrap gap-2">
            {categories.map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={category === c}
                onClick={() => setCategory(c)}
                className={`chip min-h-11 px-4 text-sm font-medium ${
                  category === c ? "chip-active" : "hover:text-foreground"
                }`}
              >
                {categoryLabel(c)}
              </button>
            ))}
          </div>
        </fieldset>

        <Field label="Distillery" htmlFor="new-bottle-distillery" hint="Optional">
          <input
            id="new-bottle-distillery"
            value={distillery}
            onChange={(e) => setDistillery(e.target.value)}
            placeholder="Heaven Hill"
            className={INPUT}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Age (years)" htmlFor="new-bottle-age" hint="Optional">
            <input
              id="new-bottle-age"
              inputMode="numeric"
              value={ageYears}
              onChange={(e) => setAgeYears(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder="12"
              className={INPUT}
            />
          </Field>
          <Field label="ABV %" htmlFor="new-bottle-abv" hint="Optional">
            <input
              id="new-bottle-abv"
              inputMode="decimal"
              value={abv}
              onChange={(e) => setAbv(e.target.value.replace(/[^0-9.]/g, ""))}
              placeholder="62.5"
              className={INPUT}
            />
          </Field>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="section-label mb-1">Add it to</legend>
          <div className="flex flex-wrap gap-2">
            {(["own", "tried", "wishlist"] as const).map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={relationship === r}
                onClick={() => setRelationship(r)}
                className={`chip min-h-11 px-4 text-sm font-medium ${
                  relationship === r ? "chip-active" : "hover:text-foreground"
                }`}
              >
                {r === "own" ? "My bar" : r === "tried" ? "Tried" : "Wishlist"}
              </button>
            ))}
          </div>
        </fieldset>

        {upc && (
          <p className="text-xs text-muted leading-relaxed">
            The barcode you scanned ({upc}) is saved with it, and starts resolving for everyone
            once the bottle is reviewed.
          </p>
        )}

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={saving}
          className="btn-primary px-6 py-3.5 font-medium disabled:opacity-60"
        >
          {saving ? "Adding…" : "Add this bottle"}
        </button>
      </form>
    </div>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={htmlFor} className="section-label flex items-baseline gap-2">
        {label}
        {hint && <span className="normal-case tracking-normal text-[10px] opacity-70">{hint}</span>}
      </label>
      {children}
    </div>
  );
}
