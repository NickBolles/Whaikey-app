"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Star, Trophy, X } from "lucide-react";
import { leafLabel } from "@/lib/flavor-wheel";
import { PourScanSlot } from "@/components/pour/scan-slot";
import { TABLE_TAGS } from "@/components/social/flight-client";
import type { OutingBoardBottle } from "@/lib/outings";
import { arrivalToast, boardArrivals } from "@/lib/outings/live";

/**
 * The outing's shared bottle list (owner request 2026-10-28): anyone on the
 * trip adds a bottle by search, barcode or label scan — or types a cask
 * sample's name — and it appears for the whole group. Each bottle shows what
 * everyone thought of it: ratings, notes and descriptors, never amounts.
 *
 * Distillery signal is poor, so writes go through a small on-device queue:
 * a failed send is kept, shown as "pending", and retried when the phone is
 * back online (and every few seconds while the page is open).
 */

type QueueItem = { qid: string; url: string; method: "POST" | "PATCH"; body: unknown; label: string; kind: "bottle" | "rating" };

/**
 * Keyed by outing AND participant: on a shared phone, a queued write must only
 * ever be shown to and replayed by the person who made it (never sent with the
 * next account's cookies).
 */
const queueKey = (scope: string) => `caskfolk:outing-queue:${scope}`;
const QUEUE_EVENT = "caskfolk-outing-queue";

function readQueue(code: string): QueueItem[] {
  try {
    const raw = window.localStorage.getItem(queueKey(code));
    return raw ? (JSON.parse(raw) as QueueItem[]) : [];
  } catch {
    return [];
  }
}
function writeQueue(code: string, items: QueueItem[]) {
  try {
    if (items.length) window.localStorage.setItem(queueKey(code), JSON.stringify(items));
    else window.localStorage.removeItem(queueKey(code));
  } catch {
    /* private mode: nothing queued survives a reload */
  }
  window.dispatchEvent(new Event(QUEUE_EVENT));
}
function subscribeQueue(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(QUEUE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(QUEUE_EVENT, onChange);
  };
}

/** Send one write. `"retry"` = network trouble or a 5xx (keep it queued); otherwise the final status. */
async function attempt(item: { url: string; method: QueueItem["method"] | "DELETE"; body: unknown }): Promise<number | "retry"> {
  try {
    const res = await fetch(item.url, { method: item.method, headers: { "content-type": "application/json" }, body: JSON.stringify(item.body) });
    return res.status >= 500 ? "retry" : res.status;
  } catch {
    return "retry";
  }
}

export function useOutingQueue(code: string) {
  const router = useRouter();
  const raw = useSyncExternalStore(
    subscribeQueue,
    () => {
      try {
        return window.localStorage.getItem(queueKey(code)) ?? "";
      } catch {
        return ""; // storage denied by browser policy: no offline queue, but the page still works
      }
    },
    () => "",
  );
  let pending: QueueItem[] = [];
  try {
    pending = raw ? (JSON.parse(raw) as QueueItem[]) : [];
  } catch {
    /* a corrupt entry shows nothing rather than crashing the outing */
  }

  const flush = useCallback(async () => {
    const items = readQueue(code);
    if (!items.length) return;
    let changed = false;
    for (const item of items) {
      const r = await attempt(item);
      if (r === "retry") break;
      // Delivered (or permanently refused): drop it either way.
      writeQueue(
        code,
        readQueue(code).filter((q) => q.qid !== item.qid),
      );
      changed = true;
    }
    if (changed) router.refresh();
  }, [code, router]);

  useEffect(() => {
    void flush();
    const onOnline = () => void flush();
    window.addEventListener("online", onOnline);
    const id = window.setInterval(() => void flush(), 8000);
    return () => {
      window.removeEventListener("online", onOnline);
      window.clearInterval(id);
    };
  }, [flush]);

  /** Send now; on network trouble keep it for later. Resolves to the HTTP status or "queued". */
  const send = useCallback(
    async (item: Omit<QueueItem, "qid">): Promise<number | "queued"> => {
      const r = await attempt(item);
      if (r !== "retry") {
        if (r < 300) router.refresh();
        return r;
      }
      writeQueue(code, [...readQueue(code), { ...item, qid: crypto.randomUUID() }]);
      return "queued";
    },
    [code, router],
  );

  return { pending, send, flush };
}

function Stars({ value, onChange, label }: { value: number | null; onChange: (n: number | null) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} star${n === 1 ? "" : "s"}`}
          onClick={() => onChange(value === n ? null : n)}
          className="tap-target flex h-11 w-10 items-center justify-center text-accent"
        >
          <Star size={22} fill={value != null && n <= value ? "currentColor" : "none"} strokeWidth={1.6} aria-hidden />
        </button>
      ))}
    </div>
  );
}

/** Add a bottle to the group's list: scan, label photo or search (the same slot as the Log sheet), or a typed name. */
function AddBottlePanel({ code, onDone, send }: { code: string; onDone: (msg: string) => void; send: ReturnType<typeof useOutingQueue>["send"] }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function add(body: { bottleId: string } | { label: string }, label: string) {
    if (busy) return;
    setBusy(true);
    const r = await send({ url: `/api/outings/${code}/bottles`, method: "POST", body, label, kind: "bottle" });
    setBusy(false);
    if (r === "queued") onDone(`No signal — ${label} will be added when you're back online.`);
    else if (r === 200) onDone(`${label} is already on the list.`);
    else if (r === 201) onDone(`Added ${label} for the group.`);
    else if (r === 409) onDone("The host has ended this outing.");
    else if (r === 429) onDone("That's the most one person can add to an outing.");
    else onDone("Couldn't add that bottle — try again.");
  }

  return (
    <div className="flex flex-col gap-3">
      <PourScanSlot onPick={(b) => void add({ bottleId: b.id }, b.name)} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const label = name.trim();
          if (label.length >= 2) void add({ label }, label).then(() => setName(""));
        }}
        className="flex flex-col gap-1.5"
      >
        <label htmlFor={`outing-add-name-${code}`} className="text-xs text-muted">
          Not in the catalog? A cask sample or distillery-only pour — add it by name:
        </label>
        <div className="flex items-center gap-2">
          <input
            id={`outing-add-name-${code}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            placeholder="Cask 1142, barrel-proof sample"
            className="min-w-0 flex-1 rounded-lg border border-border-subtle bg-surface px-3 py-2.5 text-base"
          />
          <button type="submit" disabled={busy || name.trim().length < 2} className="btn-secondary shrink-0 px-4 py-2.5 text-sm disabled:opacity-60">
            Add
          </button>
        </div>
      </form>
    </div>
  );
}

/** Rate (or re-rate) a bottle on the list — a tasting note, with or without a pour in your journal. */
function RateForm({
  code,
  bottle,
  send,
  onDone,
}: {
  code: string;
  bottle: OutingBoardBottle;
  send: ReturnType<typeof useOutingQueue>["send"];
  onDone: (msg: string) => void;
}) {
  const [rating, setRating] = useState<number | null>(bottle.mine?.rating ?? null);
  const [tags, setTags] = useState<Record<string, number>>(bottle.mine?.flavorTags ?? {});
  const [note, setNote] = useState(bottle.mine?.note ?? "");
  const [busy, setBusy] = useState(false);
  async function save() {
    if (busy) return;
    setBusy(true);
    const payload = { rating, flavorTags: Object.keys(tags).length ? tags : null, note: note.trim() || null };
    const r = bottle.mine
      ? await send({ url: `/api/outings/${code}/tastings/${bottle.mine.id}`, method: "PATCH", body: payload, label: bottle.label, kind: "rating" })
      : await send({
          url: `/api/outings/${code}/tastings`,
          method: "POST",
          body: { ...(bottle.bottleId ? { bottleId: bottle.bottleId } : { label: bottle.label }), ...payload },
          label: bottle.label,
          kind: "rating",
        });
    setBusy(false);
    if (r === "queued") onDone(`No signal — your rating of ${bottle.label} will be sent when you're back online.`);
    else if (typeof r === "number" && r < 300) onDone(`Rated ${bottle.label}.`);
    else if (r === 409) onDone("The host has ended this outing.");
    else onDone("Couldn't save — try again.");
  }
  const tagChoices = [...new Set([...TABLE_TAGS, ...Object.keys(tags)])];
  return (
    <div className="flex flex-col gap-2 border-t border-border-subtle pt-2">
      <Stars value={rating} onChange={setRating} label={`Your rating for ${bottle.label}`} />
      <ul className="flex flex-wrap gap-1.5 py-1" aria-label="Descriptors">
        {tagChoices.map((id) => {
          const on = id in tags;
          return (
            <li key={id}>
              <button
                type="button"
                aria-pressed={on}
                onClick={() => {
                  const next = { ...tags };
                  if (on) delete next[id];
                  else if (Object.keys(next).length < 8) next[id] = 2;
                  setTags(next);
                }}
                className={`tap-target chip px-2.5 py-1 text-xs ${on ? "border-accent text-accent" : ""}`}
              >
                {leafLabel(id) ?? id}
              </button>
            </li>
          );
        })}
      </ul>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={500}
        rows={2}
        placeholder="A note for the group (optional)"
        aria-label={`Your note on ${bottle.label}`}
        className="rounded-lg border border-border-subtle bg-surface px-3 py-2 text-base"
      />
      <button type="button" disabled={busy} onClick={() => void save()} className="btn-primary py-2.5 disabled:opacity-60">
        {busy ? "Saving…" : bottle.mine ? "Update my rating" : "Save my rating"}
      </button>
    </div>
  );
}

function BottleCard({
  code,
  bottle,
  canRate,
  canPour,
  canRemove,
  send,
  onNotice,
  fresh = false,
}: {
  code: string;
  bottle: OutingBoardBottle;
  /** Just arrived from someone else: a brief highlight. */
  fresh?: boolean;
  canRate: boolean;
  canPour: boolean;
  /** The viewer added it, or hosts the outing. Ratings already given stay. */
  canRemove: boolean;
  send: ReturnType<typeof useOutingQueue>["send"];
  onNotice: (msg: string) => void;
}) {
  const [rating, setRating] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [wishing, setWishing] = useState(false);
  const router = useRouter();
  /** Wishlist without ever demoting a bottle already owned or tried (keepExisting). */
  async function wishlist() {
    if (!bottle.bottleId || wishing) return;
    setWishing(true);
    try {
      const res = await fetch("/api/user-bottles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bottleId: bottle.bottleId, relationship: "wishlist", keepExisting: true }),
      });
      if (res.status === 201) onNotice(`Added ${bottle.label} to your wishlist.`);
      else if (res.ok) {
        const row = (await res.json().catch(() => null)) as { relationship?: string } | null;
        const where = row?.relationship === "own" ? "on your shelf" : row?.relationship === "tried" ? "in your tried list" : "on your wishlist";
        onNotice(`${bottle.label} is already ${where}.`);
      } else onNotice(`Couldn't add ${bottle.label} to your wishlist.`);
    } catch {
      onNotice("No signal — try the wishlist again when you're back online.");
    } finally {
      setWishing(false);
    }
  }
  async function remove() {
    if (!bottle.entryId) return;
    setRemoving(true);
    const r = await attempt({ url: `/api/outings/${encodeURIComponent(code)}/bottles/${encodeURIComponent(bottle.entryId)}`, method: "DELETE", body: undefined });
    setRemoving(false);
    if (typeof r === "number" && r < 300) {
      onNotice(`Removed ${bottle.label} from the list.`);
      router.refresh();
    } else onNotice(r === "retry" ? "No signal — try removing it again when you're back online." : `Couldn't remove ${bottle.label}.`);
  }
  return (
    <li className={`card-flat flex flex-col gap-2 p-3 ${bottle.favourite ? "border border-accent" : ""} ${fresh ? "outing-arrival" : ""}`} aria-label={bottle.label}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {bottle.favourite && (
            <p className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-accent">
              <Trophy size={12} aria-hidden /> Group favourite
            </p>
          )}
          <p className="font-display text-base font-semibold leading-tight">
            {bottle.bottleId ? (
              <Link href={`/bottles/${bottle.bottleId}`} className="hover:text-accent">
                {bottle.label}
              </Link>
            ) : (
              bottle.label
            )}
          </p>
          {bottle.addedBy && <p className="text-xs text-muted">Added by {bottle.addedBy}</p>}
        </div>
        <p className="shrink-0 text-right">
          {bottle.average != null ? (
            <span className="text-accent" aria-label={`Group average ${bottle.average.toFixed(1)} of 5`}>
              ★ {bottle.average.toFixed(1)}
            </span>
          ) : (
            <span className="text-xs text-muted">Not rated yet</span>
          )}
        </p>
      </div>
      {bottle.groupTags.length > 0 && <p className="text-xs text-foreground/85">Group: {bottle.groupTags.join(" · ")}</p>}
      {bottle.votes.length > 0 && (
        <ul className="flex flex-col gap-1" aria-label={`What everyone thought of ${bottle.label}`}>
          {bottle.votes.map((v) => (
            <li key={v.who} className="text-sm">
              <span className={v.mine ? "font-medium" : ""}>{v.who}</span>
              {v.rating != null && <span className="ml-1.5 text-accent">★ {v.rating}</span>}
              {v.tags.length > 0 && <span className="ml-1.5 text-xs text-muted">{v.tags.join(" · ")}</span>}
              {v.note && <span className="block text-xs italic text-muted">&ldquo;{v.note}&rdquo;</span>}
            </li>
          ))}
        </ul>
      )}
      {bottle.notYet.length > 0 && <p className="text-xs text-muted">Not yet: {bottle.notYet.join(", ")}</p>}
      {(canRate || (canRemove && bottle.entryId) || (canPour && bottle.bottleId)) && (
        <div className="flex flex-wrap items-center gap-2">
          {canRate && (
          <button type="button" aria-expanded={rating} onClick={() => setRating((o) => !o)} className="btn-secondary px-4 py-2 text-sm">
            {bottle.mine ? "Edit my rating" : "Rate"}
          </button>
          )}
          {canRate && canPour && bottle.bottleId && (
            <Link href={`/pour?bottleId=${encodeURIComponent(bottle.bottleId)}&outing=${encodeURIComponent(code)}`} className="tap-target px-2 py-2 text-sm text-accent">
              Log a pour →
            </Link>
          )}
          {canPour && bottle.bottleId && (
            <button type="button" onClick={() => void wishlist()} disabled={wishing} className="tap-target px-2 py-2 text-sm text-accent disabled:opacity-60">
              {wishing ? "Adding…" : "Add to my wishlist"}
            </button>
          )}
          {canRemove && bottle.entryId && (
            <button type="button" onClick={remove} disabled={removing} className="tap-target ml-auto px-2 py-2 text-xs text-muted hover:text-foreground">
              {removing ? "Removing…" : "Remove"}
            </button>
          )}
        </div>
      )}
      {rating && (
        <RateForm
          code={code}
          bottle={bottle}
          send={send}
          onDone={(m) => {
            setRating(false);
            onNotice(m);
          }}
        />
      )}
    </li>
  );
}

export function OutingBottleBoard({
  code,
  board,
  canAdd,
  canPour,
  isHost = false,
  participantId = null,
}: {
  code: string;
  board: OutingBoardBottle[];
  /** The host may take any bottle off the list. */
  isHost?: boolean;
  /** The viewer's seat; scopes the offline queue to this person. */
  participantId?: string | null;
  /** On the trip and the outing is open. */
  canAdd: boolean;
  /** Signed in with an account (guests can rate but have no journal). */
  canPour: boolean;
}) {
  const { pending, send } = useOutingQueue(`${code}:${participantId ?? "none"}`);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const pendingBottles = pending.filter((p) => p.kind === "bottle" && !board.some((b) => b.label === p.label));
  const pendingRatings = pending.filter((p) => p.kind === "rating");
  // Live arrivals: diff the board against the last render (derived during
  // render, the React-recommended way to react to a prop change).
  const [prevBoard, setPrevBoard] = useState(board);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const [toast, setToast] = useState<string | null>(null);
  if (prevBoard !== board) {
    const arrivals = boardArrivals(prevBoard, board);
    setPrevBoard(board);
    if (arrivals.length) {
      setFresh(new Set(arrivals.map((a) => a.key)));
      setToast(arrivalToast(arrivals));
    }
  }
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => {
      setToast(null);
      setFresh(new Set());
    }, 4500);
    return () => window.clearTimeout(id);
  }, [toast]);

  return (
    <section aria-labelledby="bottles-heading" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 id="bottles-heading" className="font-display text-lg font-semibold">
          The bottles
        </h2>
        {canAdd && (
          <button type="button" aria-expanded={adding} onClick={() => setAdding((o) => !o)} className="btn-primary flex items-center gap-1 px-4 py-2 text-sm">
            {adding ? <X size={16} aria-hidden /> : <Plus size={16} aria-hidden />}
            {adding ? "Done" : "Add a bottle"}
          </button>
        )}
      </div>
      <p className="text-xs text-muted">Everyone on this outing sees each other&rsquo;s ratings and notes for these bottles. Amounts are never shown.</p>
      {adding && canAdd && (
        <div className="card p-3">
          <AddBottlePanel code={code} send={send} onDone={setNotice} />
        </div>
      )}
      {notice && (
        <p role="status" className="text-xs text-muted">
          {notice}
        </p>
      )}
      {(pendingBottles.length > 0 || pendingRatings.length > 0) && (
        <ul aria-label="Waiting for signal" className="flex flex-col gap-1">
          {pendingBottles.map((p) => (
            <li key={p.qid} className="card-flat flex items-center justify-between p-3 text-sm opacity-70">
              <span>{p.label}</span>
              <span className="text-xs text-muted">Pending — will add when online</span>
            </li>
          ))}
          {pendingRatings.map((p) => (
            <li key={p.qid} className="text-xs text-muted">
              Your rating of {p.label} is pending — it&rsquo;ll send when you&rsquo;re back online.
            </li>
          ))}
        </ul>
      )}
      {toast && (
        <p role="status" aria-live="polite" className="outing-toast">
          {toast}
        </p>
      )}
      {board.length === 0 && pendingBottles.length === 0 ? (
        <p className="text-sm text-muted">No bottles yet — add what&rsquo;s being poured and it shows up for everyone.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {board.map((b) => (
            <BottleCard key={b.key} code={code} bottle={b} fresh={fresh.has(b.key)} canRate={canAdd} canPour={canPour} canRemove={isHost || (!!participantId && b.addedByMe)} send={send} onNotice={setNotice} />
          ))}
        </ul>
      )}
    </section>
  );
}
