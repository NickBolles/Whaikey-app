"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Car, Star, X } from "lucide-react";
import { leafLabel } from "@/lib/flavor-wheel";
import { share } from "@/lib/native/share";
import { TABLE_TAGS } from "@/components/social/flight-client";
import { BRAND_NAME } from "@/lib/brand";

async function send(url: string, method: string, body?: unknown) {
  return fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Signed-in: join the outing with your account. */
export function JoinOutingButton({ code }: { code: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [needsProfile, setNeedsProfile] = useState(false);
  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const res = await send("/api/outings/join", "POST", { code }).catch(() => null);
          setBusy(false);
          if (res?.status === 409) setNeedsProfile(true);
          else router.refresh();
        }}
        className="btn-primary px-8 py-3 disabled:opacity-60"
      >
        {busy ? "Joining…" : "Join the outing"}
      </button>
      {needsProfile && (
        <p role="status" className="text-center text-sm text-muted">
          Set up your profile first so the group can see what you log —{" "}
          <a href="/friends/people" className="text-accent">
            it takes a moment
          </a>
          .
        </p>
      )}
    </div>
  );
}

function subscribeStorage(onChange: () => void) {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * The ride card (D22): one line of planning help, shown on the outing page
 * and dismissible for good on this device. Never a notification, never
 * repeated, never about how much anyone has had.
 */
export function RideReminder({ code }: { code: string }) {
  const key = `whaikey:outing-ride:${code}`;
  const [dismissedNow, setDismissedNow] = useState(false);
  // Server and first paint: hidden, so a dismissed card never flashes back.
  const stored = useSyncExternalStore(subscribeStorage, () => readStorage(key), () => "1");
  const hidden = dismissedNow || stored === "1";
  if (hidden) return null;
  return (
    <aside aria-label="Getting there and back" className="card-flat flex items-start gap-3 p-3">
      <Car size={18} className="mt-0.5 shrink-0 text-accent" aria-hidden />
      <p className="min-w-0 flex-1 text-sm">
        Sorted the ride? Pick a designated driver or book a car before the first tasting. Small sips and the spit
        bucket are how the pros do a distillery — tasting is the point.
      </p>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => {
          setDismissedNow(true);
          try {
            window.localStorage.setItem(key, "1");
          } catch {
            /* private mode: dismissed for this visit */
          }
        }}
        className="tap-target -m-1 flex h-11 w-11 shrink-0 items-center justify-center text-muted hover:text-foreground"
      >
        <X size={16} aria-hidden />
      </button>
    </aside>
  );
}

interface BottleHit {
  id: string;
  name: string;
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

/**
 * Log something you tasted (D22). Search the catalog, or type whatever the
 * distillery poured — a cask sample, a gift-shop-only bottling — and log it
 * by name. Signed-in tasters can also put a missing bottle in the catalog
 * through the normal add-a-bottle flow, which returns here with it picked.
 */
export function QuickAddTasting({
  code,
  signedIn,
  initialBottle,
}: {
  code: string;
  signedIn: boolean;
  initialBottle: BottleHit | null;
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<BottleHit[]>([]);
  const [picked, setPicked] = useState<{ bottleId?: string; label: string } | null>(
    initialBottle ? { bottleId: initialBottle.id, label: initialBottle.name } : null,
  );
  const [rating, setRating] = useState<number | null>(null);
  const [tags, setTags] = useState<Record<string, number>>({});
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/bottles/search?q=${encodeURIComponent(term)}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : { results: [] }))
        .then((d: { results?: BottleHit[] }) => setResults((d.results ?? []).slice(0, 5)))
        .catch(() => {});
    }, 200);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  function reset() {
    setPicked(null);
    setQ("");
    setResults([]);
    setRating(null);
    setTags({});
    setNote("");
  }

  async function save() {
    if (!picked || busy) return;
    setBusy(true);
    setStatus(null);
    const res = await send(`/api/outings/${code}/tastings`, "POST", {
      ...(picked.bottleId ? { bottleId: picked.bottleId } : { label: picked.label }),
      rating,
      flavorTags: Object.keys(tags).length ? tags : null,
      note: note.trim() || null,
    }).catch(() => null);
    setBusy(false);
    if (res?.status === 201) {
      reset();
      setStatus("Logged to the outing.");
      // Drop ?added= so a refresh doesn't re-pick the bottle.
      if (initialBottle) router.replace(`/o/${code}`);
      router.refresh();
    } else if (res?.status === 409) setStatus("The host has ended this outing.");
    else if (res?.status === 429) setStatus("That's the most one person can log on an outing.");
    else setStatus("Couldn't save — check your connection and try again.");
  }

  const term = q.trim();
  return (
    <section aria-labelledby="add-heading" className="card flex flex-col gap-3 p-3">
      <h2 id="add-heading" className="font-display text-lg font-semibold">
        Log a tasting
      </h2>
      {!picked ? (
        <>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="What did they pour?"
            aria-label="What did they pour?"
            maxLength={120}
            className="rounded-lg border border-border-subtle bg-surface px-3 py-2.5 text-base"
          />
          {term.length >= 2 && (
            <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle">
              {results.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => setPicked({ bottleId: r.id, label: r.name })}
                    className="tap-target w-full px-3 py-2.5 text-left text-sm hover:bg-surface-raised"
                  >
                    {r.name}
                  </button>
                </li>
              ))}
              <li>
                <button
                  type="button"
                  onClick={() => setPicked({ label: term })}
                  className="tap-target w-full px-3 py-2.5 text-left text-sm text-accent hover:bg-surface-raised"
                >
                  Log &ldquo;{term}&rdquo; as poured here
                  <span className="block text-xs text-muted">For cask samples and distillery-only bottles</span>
                </button>
              </li>
              {signedIn && (
                <li>
                  <Link
                    href={`/bottles/new?name=${encodeURIComponent(term)}&next=${encodeURIComponent(`/o/${code}`)}`}
                    className="tap-target block px-3 py-2.5 text-sm text-muted hover:bg-surface-raised hover:text-foreground"
                  >
                    Add it to the catalog first →
                  </Link>
                </li>
              )}
            </ul>
          )}
        </>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 truncate font-medium">{picked.label}</p>
            <button type="button" onClick={reset} className="tap-target shrink-0 px-2 text-xs text-muted hover:text-foreground">
              Change
            </button>
          </div>
          <Stars value={rating} onChange={setRating} label={`Rating for ${picked.label}`} />
          <ul className="flex flex-wrap gap-1.5" aria-label="Descriptors">
            {TABLE_TAGS.map((id) => {
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
                    className={`chip px-2.5 py-1 text-xs ${on ? "border-accent text-accent" : ""}`}
                  >
                    {leafLabel(id)}
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
            aria-label="Tasting note"
            className="rounded-lg border border-border-subtle bg-surface px-3 py-2 text-base"
          />
          <button type="button" disabled={busy} onClick={() => void save()} className="btn-primary py-2.5 disabled:opacity-60">
            {busy ? "Saving…" : "Log it"}
          </button>
        </div>
      )}
      {status && (
        <p role="status" className="text-xs text-muted">
          {status}
        </p>
      )}
    </section>
  );
}

/** A line on the shared feed. */
export function OutingNoteComposer({ code }: { code: string }) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!body.trim() || busy) return;
        setBusy(true);
        const res = await send(`/api/outings/${code}/notes`, "POST", { body }).catch(() => null);
        setBusy(false);
        if (res?.status === 201) {
          setBody("");
          router.refresh();
        }
      }}
      className="flex items-center gap-2"
    >
      <input
        value={body}
        onChange={(e) => setBody(e.target.value)}
        maxLength={280}
        placeholder="Add a note for the group"
        aria-label="Add a note for the group"
        className="min-w-0 flex-1 rounded-lg border border-border-subtle bg-surface px-3 py-2.5 text-base"
      />
      <button type="submit" disabled={busy || !body.trim()} className="btn-secondary shrink-0 px-4 py-2.5 text-sm disabled:opacity-60">
        Post
      </button>
    </form>
  );
}

/** Remove your own item, or (host) hide someone else's. */
export function FeedItemAction({ code, kind, id, mode }: { code: string; kind: "tasting" | "note"; id: string; mode: "delete" | "hide" }) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={async () => {
        if (!window.confirm(mode === "delete" ? "Remove this from the outing?" : "Hide this from the group?")) return;
        if (mode === "delete") await send(`/api/outings/${code}/${kind === "tasting" ? "tastings" : "notes"}/${id}`, "DELETE").catch(() => null);
        else await send(`/api/outings/${code}/hide`, "POST", { kind, id }).catch(() => null);
        router.refresh();
      }}
      className="tap-target px-1 text-[11px] text-muted hover:text-foreground"
    >
      {mode === "delete" ? "Remove" : "Hide"}
    </button>
  );
}

/** Host: share the link, invite friends in-app, end the outing, delete it. */
export function OutingHostControls({ code, title, state }: { code: string; title: string; state: "open" | "ended" }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [friends, setFriends] = useState<Array<{ userId: string; handle: string; displayName: string | null }> | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [sent, setSent] = useState<number | null>(null);

  async function end() {
    if (busy || !window.confirm("End the outing? Everyone gets the recap, and nothing more can be logged.")) return;
    setBusy(true);
    await send(`/api/outings/${code}/state`, "POST", { to: "ended" }).catch(() => null);
    setBusy(false);
    router.refresh();
  }
  async function remove() {
    if (busy || !window.confirm("Delete this outing and everything logged on it, for everyone?")) return;
    setBusy(true);
    const res = await send(`/api/outings/${code}`, "DELETE").catch(() => null);
    setBusy(false);
    if (res?.ok) router.push("/clubs");
  }
  async function loadFriends() {
    const res = await fetch(`/api/outings/${code}/invite`, { cache: "no-store" }).catch(() => null);
    const data = res?.ok ? ((await res.json()) as { items: Array<{ userId: string; handle: string; displayName: string | null }> }) : { items: [] };
    setFriends(data.items);
  }
  async function invite() {
    if (!chosen.size) return;
    setBusy(true);
    const res = await send(`/api/outings/${code}/invite`, "POST", { userIds: [...chosen] }).catch(() => null);
    setBusy(false);
    const data = res?.ok ? ((await res.json()) as { sent: number }) : { sent: 0 };
    setSent(data.sent);
    setChosen(new Set());
    void loadFriends();
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {state === "open" && (
          <>
            <button
              type="button"
              onClick={() => void share({ title, text: `Join "${title}" on ${BRAND_NAME}`, url: `${window.location.origin}/o/${code}` })}
              className="btn-secondary px-4 py-2 text-sm"
            >
              Share invite
            </button>
            <button type="button" onClick={() => void loadFriends()} className="btn-secondary px-4 py-2 text-sm">
              Invite friends
            </button>
            <button type="button" disabled={busy} onClick={() => void end()} className="btn-primary px-4 py-2 text-sm disabled:opacity-60">
              End &amp; see recap
            </button>
          </>
        )}
        <button type="button" disabled={busy} onClick={() => void remove()} className="tap-target px-2 py-2 text-xs text-muted hover:text-foreground">
          Delete outing
        </button>
      </div>
      {friends && (
        <div className="flex flex-col gap-2 rounded-lg border border-border-subtle p-2">
          {friends.length === 0 ? (
            <p className="text-xs text-muted">No friends left to invite in the app — share the link or the QR instead.</p>
          ) : (
            <ul className="flex flex-col">
              {friends.map((f) => (
                <li key={f.userId}>
                  <label className="tap-target flex items-center gap-2 py-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={chosen.has(f.userId)}
                      onChange={(e) => {
                        const next = new Set(chosen);
                        if (e.target.checked) next.add(f.userId);
                        else next.delete(f.userId);
                        setChosen(next);
                      }}
                      className="h-4 w-4"
                    />
                    {f.displayName || `@${f.handle}`} <span className="text-xs text-muted">@{f.handle}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {friends.length > 0 && (
            <button type="button" disabled={busy || !chosen.size} onClick={() => void invite()} className="btn-primary self-start px-4 py-2 text-sm disabled:opacity-60">
              Send invites
            </button>
          )}
          {sent != null && (
            <p role="status" className="text-xs text-muted">
              {sent === 1 ? "1 invite sent." : `${sent} invites sent.`}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** A guest who has just signed in keeps what they logged on this outing. */
export function ClaimOutingSeatButton({ code }: { code: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={async () => {
        await send(`/api/outings/${code}/claim`, "POST", {}).catch(() => null);
        router.refresh();
      }}
      className="btn-primary px-4 py-2 text-sm"
    >
      Keep what I logged
    </button>
  );
}

/**
 * New bottles, ratings and notes from the group appear without a reload. The
 * page listens to a Server-Sent Events stream (/live) that pushes the
 * viewer's stamp the moment something they can see changes; when streaming
 * isn't available (old WebView, proxy, error loop) it falls back to a light
 * poll of the same stamp. Paused in the background, stopped when the outing
 * ends. It carries no presence — nobody learns who has the page open.
 */
export function OutingWatcher({ code, stamp }: { code: string; stamp: string }) {
  const router = useRouter();
  const last = useRef(stamp);
  useEffect(() => {
    last.current = stamp;
  }, [stamp]);
  useEffect(() => {
    let live = true;
    let source: EventSource | null = null;
    let pollId: number | null = null;
    let failures = 0;
    const seen = (next: string) => {
      if (live && next && next !== last.current) {
        last.current = next;
        router.refresh();
      }
    };
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      const res = await fetch(`/api/outings/${code}/state`, { cache: "no-store" }).catch(() => null);
      if (!live || !res?.ok) return;
      const data = (await res.json()) as { stamp: string };
      seen(data.stamp);
    };
    const startPoll = () => {
      if (pollId == null) pollId = window.setInterval(() => void tick(), 5000);
    };
    const stopStream = () => {
      source?.close();
      source = null;
    };
    const startStream = () => {
      if (!live || source || typeof window.EventSource !== "function" || document.visibilityState !== "visible") return;
      const es = new window.EventSource(`/api/outings/${code}/live`);
      source = es;
      es.addEventListener("stamp", (e) => {
        failures = 0;
        try {
          seen((JSON.parse((e as MessageEvent).data) as { stamp: string }).stamp);
        } catch {
          /* ignore a malformed frame */
        }
      });
      es.addEventListener("ended", () => {
        stopStream();
        router.refresh();
      });
      es.onerror = () => {
        // EventSource reconnects by itself after a window closes; repeated
        // errors mean streaming doesn't work here, so poll instead.
        failures += 1;
        if (failures >= 3) {
          stopStream();
          startPoll();
        }
      };
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void tick();
        if (pollId == null) startStream();
      } else {
        stopStream();
      }
    };
    if (typeof window.EventSource === "function") startStream();
    else startPoll();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      stopStream();
      if (pollId != null) window.clearInterval(pollId);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [code, router]);
  return null;
}
