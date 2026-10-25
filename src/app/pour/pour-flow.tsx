"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, ChevronUp, Eye, X } from "lucide-react";
import { SERVING_STYLES, type PourVisibility, type ServingStyle } from "@/db/schema";
import { matchLeafIds } from "@/lib/flavor-wheel";
import { previousPath } from "@/lib/nav-history";
import { StarRating } from "@/components/star-rating";
import { FlavorWheelInput } from "@/components/flavor-wheel-input";
import { PourSizePicker } from "@/components/pour-size-picker";
import { NoteCapture, type ExtractedTastingNote } from "@/components/note-capture";
import { VisibilityChips } from "@/components/visibility-chips";
import { useToast } from "@/components/toast";
import { PourScanSlot, type PickMeta } from "@/components/pour/scan-slot";
import { bottleMeta, type ScanBottle } from "@/components/pour/scan-decision";
import { clearDraft, hasDraftContent, loadDraft, saveDraft } from "@/components/pour/pour-draft";
import { enqueuePour, newPourClientId } from "@/lib/native/offline-queue";

export interface BottlePick {
  id: string;
  name: string;
  distillery?: string | null;
  category?: string | null;
}

/** The three places a note can land; one persistent wheel serves them all. */
const NOTE_SECTIONS = [
  { key: "nose", label: "Nose", placeholder: "What do you smell?" },
  { key: "palate", label: "Palate", placeholder: "What do you taste?" },
  { key: "finish", label: "Finish", placeholder: "How does it linger?" },
] as const;

type NoteSection = (typeof NOTE_SECTIONS)[number]["key"];

const VISIBILITY_SUMMARY: Record<PourVisibility, string> = {
  private: "Only me",
  friends: "Friends",
  followers: "Followers",
  public: "Public",
};

/**
 * Log a pour — the scan-first quick-confirm sheet (docs/STORYBOARD.md §2.2 as
 * amended by the design board's direction B and decisions S1–S6).
 *
 * Top to bottom: the bottle slot (live viewfinder, type beneath, recents) →
 * rating (optional) → serving → "Add notes, wheel, photo", which expands the
 * full D3 richness in place → one sticky Save. An exact barcode fills the slot
 * without a confirm step ("Not it?" + Undo cover a wrong read), so a bottle in
 * front of you is ＋ → ★ → Save: three taps. A prefilled bottle (any Pour
 * button) is the same three.
 *
 * Notes can start before the bottle (D4); closing keeps a 24 h draft (Q2).
 * After Save a toast carries Undo and the sheet returns where you came from —
 * there is no "Poured." page any more.
 */
export function PourFlow({ userId, initialBottle = null, initialBottleMissing = false }: { userId?: string; initialBottle?: BottlePick | null; initialBottleMissing?: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [bottle, setBottle] = useState<ScanBottle | null>(initialBottle);
  const [pickedVia, setPickedVia] = useState<PickMeta | null>(null);
  const [notItOpen, setNotItOpen] = useState(false);
  const [rating, setRating] = useState<number | null>(null);
  const [servingStyle, setServingStyle] = useState<ServingStyle | null>(null);
  const [amountMl, setAmountMl] = useState<number>(45);
  const [activeSection, setActiveSection] = useState<NoteSection>("nose");
  const [detailOpen, setDetailOpen] = useState(false);
  const [companions, setCompanions] = useState("");
  const [nose, setNose] = useState("");
  const [palate, setPalate] = useState("");
  const [finish, setFinish] = useState("");
  const [freeform, setFreeform] = useState("");
  const [flavorTags, setFlavorTags] = useState<Record<string, number>>({});
  // Default visibility is the account's saved preference, "Only me" until it
  // loads (owner decision on D19 is pending: do not widen the default here).
  const [visibility, setVisibility] = useState<PourVisibility>("private");
  const visibilityDirtyRef = useRef(false);
  const [visibilityChosen, setVisibilityChosen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [draftRestored, setDraftRestored] = useState(false);
  const clientIdRef = useRef<string | null>(null);
  const hydratedRef = useRef(false);
  // Set once the pour is saved or discarded, so the unmount flush below
  // cannot write the draft back.
  const finishedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/social/prefs")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { defaultPourVisibility?: PourVisibility } | null) => {
        if (!cancelled && data?.defaultPourVisibility && !visibilityDirtyRef.current) setVisibility(data.defaultPourVisibility);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Resume a draft from the last 24 h. A Pour button that names a bottle wins
  // over a draft's bottle, but the draft's words still come back.
  useEffect(() => {
    const draft = loadDraft(userId);
    hydratedRef.current = true;
    if (!draft) return;
    /* eslint-disable react-hooks/set-state-in-effect -- one-shot restore from localStorage, which the server render can't see */
    if (!initialBottle && draft.bottle) setBottle(draft.bottle);
    setRating(draft.rating);
    if (draft.servingStyle && (SERVING_STYLES as readonly string[]).includes(draft.servingStyle)) setServingStyle(draft.servingStyle as ServingStyle);
    setAmountMl(draft.amountMl || 45);
    setFreeform(draft.freeform);
    setNose(draft.nose);
    setPalate(draft.palate);
    setFinish(draft.finish);
    setFlavorTags(draft.flavorTags ?? {});
    setCompanions(draft.companions);
    if (draft.visibility) {
      // An explicit choice outranks the account default arriving later.
      visibilityDirtyRef.current = true;
      setVisibilityChosen(true);
      setVisibility(draft.visibility);
    }
    if (draft.freeform || draft.nose || draft.palate || draft.finish || Object.keys(draft.flavorTags ?? {}).length > 0) setDetailOpen(true);
    setDraftRestored(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [userId, initialBottle]);

  const draftContent = { bottle, rating, servingStyle, amountMl, freeform, nose, palate, finish, flavorTags, companions };
  const hasContent = hasDraftContent({ ...draftContent, bottle: bottle && bottle.id !== initialBottle?.id ? bottle : null });
  const draftVisibility = visibilityChosen ? visibility : null;
  // The latest fields, for the flush on close/unmount: the debounced write
  // below can still be pending when the sheet goes away.
  const latestDraftRef = useRef({ ...draftContent, visibility: draftVisibility });
  useEffect(() => {
    latestDraftRef.current = { bottle, rating, servingStyle, amountMl, freeform, nose, palate, finish, flavorTags, companions, visibility: draftVisibility };
    if (!hydratedRef.current || finishedRef.current) return;
    const t = setTimeout(() => {
      // Saved or discarded while this was pending: never write it back.
      if (!finishedRef.current) saveDraft(userId, latestDraftRef.current);
    }, 300);
    return () => clearTimeout(t);
  }, [userId, bottle, rating, servingStyle, amountMl, freeform, nose, palate, finish, flavorTags, companions, draftVisibility]);
  useEffect(
    () => () => {
      // Only ever adds: an empty flush would erase a stored draft (and React's
      // dev double-mount runs this before the restore has landed).
      if (hydratedRef.current && !finishedRef.current && hasDraftContent(latestDraftRef.current)) saveDraft(userId, latestDraftRef.current);
    },
    [userId],
  );

  function leave() {
    const prev = previousPath();
    if (prev && prev !== "/pour") router.back();
    else router.push("/");
  }

  function pick(next: ScanBottle, meta: PickMeta) {
    setBottle(next);
    setPickedVia(meta);
    setNotItOpen(false);
    if (meta.via === "barcode") {
      // S2: no confirm step on an exact barcode — Undo and "Not it?" cover it.
      toast.show({
        message: `Matched ${next.name}`,
        undo: () => {
          setBottle(null);
          setPickedVia(null);
        },
      });
    }
  }

  const applyExtraction = (r: ExtractedTastingNote) => {
    if (r.nose && !nose.trim()) setNose(r.nose);
    if (r.palate && !palate.trim()) setPalate(r.palate);
    if (r.finish && !finish.trim()) setFinish(r.finish);
    if (Object.keys(r.flavorTags).length > 0) setFlavorTags((cur) => ({ ...r.flavorTags, ...cur }));
    if (r.suggestedRating != null && rating == null) setRating(r.suggestedRating);
    if (r.servingStyle && servingStyle == null && (SERVING_STYLES as readonly string[]).includes(r.servingStyle)) {
      setServingStyle(r.servingStyle as ServingStyle);
    }
  };

  const submit = async () => {
    if (!bottle || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    // Minted once per pour, not per attempt, so a retry collapses onto a save
    // that reached the server but lost its response.
    clientIdRef.current ??= newPourClientId();
    const clientId = clientIdRef.current;
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
      context: companions.trim() ? { companions: companions.trim() } : undefined,
      note: hasNote ? noteFields : undefined,
      visibility,
      clientId,
      expectedUserId: userId,
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
      const pourId = await res
        .json()
        .then((body: { pour?: { id?: unknown } }) => (typeof body.pour?.id === "string" ? body.pour.id : null))
        .catch(() => null);
      clientIdRef.current = null;
      finishedRef.current = true;
      clearDraft(userId);
      toast.show({
        message: `Poured ${bottle.name}${rating != null ? ` · ★${rating.toFixed(1)}` : ""}`,
        tone: "success",
        undo: pourId
          ? async () => {
              const undone = await fetch(`/api/pours/${encodeURIComponent(pourId)}`, { method: "DELETE" });
              if (!undone.ok) throw new Error(`DELETE /api/pours/${pourId} → ${undone.status}`);
              router.refresh();
            }
          : undefined,
        action: { label: "Journal", onClick: () => router.push("/history") },
      });
      leave();
      router.refresh();
    } catch (err) {
      // No signal where the whiskey is (PLAN.md §4.2): queue rather than lose
      // the note. A server that answered "no" is a real error.
      if (err instanceof TypeError) {
        await enqueuePour({ body: payload, bottleName: bottle.name, userId });
        clientIdRef.current = null;
        finishedRef.current = true;
        clearDraft(userId);
        toast.show({ message: `Saved ${bottle.name} on your phone — it syncs when you’re back online.` });
        leave();
      } else {
        setSubmitError(err instanceof Error ? err.message : "Something went wrong.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  function discard() {
    finishedRef.current = true;
    clearDraft(userId);
    leave();
  }

  return (
    <div className="mx-auto flex min-h-[calc(100dvh-4rem)] max-w-lg flex-col">
      <div data-pour-sheet className="flex-1 bg-background px-3 pt-2 pb-4">
        <div aria-hidden className="mx-auto mb-2 h-1 w-9 rounded-full bg-border" />
        <header className="flex min-h-11 items-center justify-between gap-2">
          <h1 className="font-display text-[20px] font-semibold leading-tight">Log a pour</h1>
          <div className="flex items-center gap-1">
            {(hasContent || draftRestored) && <span className="text-xs text-muted">{draftRestored ? "Draft restored" : "Draft kept 24h"}</span>}
            <button type="button" onClick={leave} aria-label="Close" className="flex h-11 w-11 items-center justify-center rounded-lg text-muted hover:bg-surface-raised hover:text-foreground">
              <X size={18} strokeWidth={1.8} aria-hidden />
            </button>
          </div>
        </header>

        {!bottle ? (
          <PourScanSlot onPick={pick} missingNotice={initialBottleMissing} />
        ) : (
          <section aria-label="Bottle" className="flex flex-col gap-1.5">
            {pickedVia?.via === "barcode" && (
              <p className="flex items-center justify-between gap-2 text-xs">
                <span className="flex items-center gap-1 text-taste-shared">
                  <Check size={14} strokeWidth={2} aria-hidden /> Barcode match
                </span>
                <button type="button" onClick={() => setNotItOpen((o) => !o)} aria-expanded={notItOpen} className="tap-target px-1 text-accent">
                  Not it?{pickedVia.alternatives && pickedVia.alternatives.length > 0 ? ` ${pickedVia.alternatives.length} other${pickedVia.alternatives.length === 1 ? "" : "s"}` : ""}
                </button>
              </p>
            )}
            <div className="card flex items-center gap-3 px-3 py-2.5" data-testid="pour-bottle">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-display text-[17px] font-semibold leading-tight">{bottle.name}</span>
                <span className="block truncate text-xs text-muted">{bottleMeta(bottle) || bottle.category}</span>
              </span>
              <button
                type="button"
                onClick={() => {
                  setBottle(null);
                  setPickedVia(null);
                  setNotItOpen(false);
                }}
                className="btn-secondary min-h-11 shrink-0 px-3 text-sm"
              >
                Change
              </button>
            </div>
            {pickedVia && pickedVia.via !== "recent" && <ShelfQuickActions bottle={bottle} />}
            {notItOpen && (
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Other bottles with this barcode">
                {(pickedVia?.alternatives ?? []).map((alt) => (
                  <button key={alt.id} type="button" onClick={() => pick(alt, { via: "search" })} className="chip min-h-11 px-3 text-xs text-foreground/90">
                    {alt.name}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    setBottle(null);
                    setPickedVia(null);
                    setNotItOpen(false);
                  }}
                  className="chip min-h-11 px-3 text-xs"
                >
                  Scan or type again
                </button>
              </div>
            )}
          </section>
        )}

        <section aria-label="Your rating" className="mt-3 flex flex-col items-center gap-1 border-t border-border pt-3">
          <h2 className="section-label">Your rating <span className="font-normal normal-case tracking-normal">· optional</span></h2>
          <StarRating value={rating} onChange={setRating} size={40} />
        </section>

        <section aria-label="Serving" className="mt-2 flex flex-wrap justify-center gap-1.5" role="group">
          {SERVING_STYLES.map((style) => (
            <button
              key={style}
              type="button"
              aria-pressed={servingStyle === style}
              onClick={() => setServingStyle((cur) => (cur === style ? null : style))}
              className={`chip min-h-11 px-3.5 text-sm capitalize ${servingStyle === style ? "chip-active font-medium" : "hover:bg-surface-raised"}`}
            >
              {style}
            </button>
          ))}
        </section>

        <button
          type="button"
          onClick={() => setDetailOpen((o) => !o)}
          aria-expanded={detailOpen}
          className="mt-3 flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border border-border bg-surface px-3 text-left text-sm hover:bg-surface-raised"
        >
          <span>Add notes, wheel, size, who can see</span>
          {detailOpen ? <ChevronUp size={18} strokeWidth={1.8} className="text-muted" aria-hidden /> : <ChevronDown size={18} strokeWidth={1.8} className="text-muted" aria-hidden />}
        </button>

        {detailOpen && (
          <div className="mt-3 flex flex-col gap-3" data-testid="pour-detail">
            <section aria-label="Capture your note" className="flex flex-col gap-2">
              <NoteCapture
                freeform={freeform}
                onFreeformChange={setFreeform}
                onApplyExtraction={applyExtraction}
                label="Say what you taste"
                placeholder="“Loads of vanilla and charred oak, long warm finish — about a four.”"
                hint="Auto-fill turns your words into a rating, flavors, and nose/palate/finish."
              />
            </section>
            <section aria-label="Tasting notes" className="flex flex-col gap-2 border-t border-border pt-3">
              <div role="tablist" aria-label="Note section" className="flex gap-1.5">
                {NOTE_SECTIONS.map((section) => {
                  const text = { nose, palate, finish }[section.key];
                  const count = matchLeafIds(text).length;
                  const active = activeSection === section.key;
                  return (
                    <button
                      key={section.key}
                      role="tab"
                      aria-selected={active}
                      onClick={() => setActiveSection(section.key)}
                      className={`tap-target inline-flex min-h-9 flex-1 items-center justify-center gap-1 rounded-full border px-2 text-xs font-medium transition-colors ${active ? "chip-active" : "border-border text-muted hover:text-foreground"}`}
                    >
                      {section.label}
                      {count > 0 && <span className="font-mono text-xs opacity-70 tabular-nums"> · {count}</span>}
                    </button>
                  );
                })}
              </div>
              {NOTE_SECTIONS.map((section) => {
                if (section.key !== activeSection) return null;
                const [value, set] = section.key === "nose" ? ([nose, setNose] as const) : section.key === "palate" ? ([palate, setPalate] as const) : ([finish, setFinish] as const);
                return (
                  <label key={section.key} className="flex flex-col gap-1.5">
                    <span className="sr-only">{section.label}</span>
                    <textarea
                      value={value}
                      onChange={(e) => set(e.target.value)}
                      rows={2}
                      placeholder={section.placeholder}
                      className="resize-y rounded-lg border border-border bg-surface p-2.5 text-sm placeholder:text-muted focus:border-accent focus:outline-none"
                    />
                  </label>
                );
              })}
              <FlavorWheelInput value={flavorTags} onChange={setFlavorTags} />
            </section>
            <section aria-label="Pour size" className="border-t border-border pt-3">
              <PourSizePicker value={amountMl} onChange={setAmountMl} />
            </section>
            <section aria-label="More" className="flex flex-col gap-2 border-t border-border pt-3">
              <label className="flex flex-col gap-1">
                <span className="section-label">With…</span>
                <input
                  value={companions}
                  onChange={(e) => setCompanions(e.target.value)}
                  placeholder="Who was there? (optional)"
                  className="h-11 rounded-lg border border-border bg-surface px-3 text-sm placeholder:text-muted focus:border-accent focus:outline-none"
                />
              </label>
              <span className="section-label">Who can see this</span>
              <VisibilityChips
                value={visibility}
                onChange={(value) => {
                  visibilityDirtyRef.current = true;
                  setVisibilityChosen(true);
                  setVisibility(value);
                }}
                idPrefix="pour-visibility"
              />
            </section>
          </div>
        )}

        <p className="mt-2 flex items-center justify-between gap-2 text-xs text-muted">
          <span className="flex items-center gap-1">
            <Eye size={14} strokeWidth={1.8} aria-hidden /> {VISIBILITY_SUMMARY[visibility]} can see
          </span>
          <span className="tabular-nums">{amountMl} ml</span>
        </p>

        {submitError && (
          <p role="alert" className="mt-2 rounded-lg border border-danger/40 bg-surface p-2.5 text-sm text-danger">
            {submitError}
          </p>
        )}
      </div>

      <div data-sticky className="sticky bottom-0 z-30 border-t border-border bg-background/95 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur">
        <button type="button" onClick={() => void submit()} disabled={!bottle || submitting} className="btn-primary min-h-12 w-full text-base disabled:opacity-50">
          {submitting ? "Saving…" : "Save pour"}
        </button>
        <p className="mt-1 flex min-h-6 items-center justify-center gap-3 text-xs text-muted">
          {!bottle ? <span>Pick a bottle to save</span> : <span>Undo for 4s after saving</span>}
          {hasContent && (
            <button type="button" onClick={discard} className="tap-target px-1 underline-offset-2 hover:text-foreground hover:underline">
              Discard
            </button>
          )}
        </p>
      </div>
    </div>
  );
}

/**
 * ＋ is also "what is this bottle?" (STORYBOARD D6): a scanned or searched
 * bottle can go on the shelf or the wishlist, or open its page, without
 * leaving the sheet or logging anything. A new shelf row confirms with Undo.
 */
function ShelfQuickActions({ bottle }: { bottle: ScanBottle }) {
  const toast = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState<"own" | "wishlist" | null>(null);
  const [done, setDone] = useState<"own" | "wishlist" | null>(null);

  async function add(relationship: "own" | "wishlist") {
    if (busy) return;
    setBusy(relationship);
    try {
      const res = await fetch("/api/user-bottles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bottleId: bottle.id, relationship }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const row = (await res.json().catch(() => null)) as { id?: string } | null;
      setDone(relationship);
      const where = relationship === "own" ? "your bar" : "your wishlist";
      toast.show({
        message: `Added ${bottle.name} to ${where}`,
        tone: "success",
        // Only a row this tap created can be taken back; re-filing a bottle
        // that was already on the shelf is not undone into deleting it.
        undo:
          res.status === 201 && row?.id
            ? async () => {
                const undone = await fetch(`/api/user-bottles/${encodeURIComponent(row.id!)}`, { method: "DELETE" });
                if (!undone.ok) throw new Error(String(undone.status));
                setDone(null);
                router.refresh();
              }
            : undefined,
      });
    } catch {
      toast.error(`Couldn't add ${bottle.name}. Try again.`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Shelf">
      <button type="button" onClick={() => void add("own")} disabled={busy !== null || done === "own"} aria-pressed={done === "own"} className={`chip min-h-11 px-3 text-xs ${done === "own" ? "chip-active" : "text-foreground/90"}`}>
        {done === "own" ? "In your bar" : "Add to bar"}
      </button>
      <button type="button" onClick={() => void add("wishlist")} disabled={busy !== null || done === "wishlist"} aria-pressed={done === "wishlist"} className={`chip min-h-11 px-3 text-xs ${done === "wishlist" ? "chip-active" : "text-foreground/90"}`}>
        {done === "wishlist" ? "Wishlisted" : "Wishlist"}
      </button>
      <Link href={`/bottles/${encodeURIComponent(bottle.id)}`} className="tap-target ml-auto px-1 text-xs text-accent">
        Bottle page →
      </Link>
    </div>
  );
}
