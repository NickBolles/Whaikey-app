"use client";

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { useRouter } from "next/navigation";
import { Star } from "lucide-react";
import { leafLabel } from "@/lib/flavor-wheel";
import { share } from "@/lib/native/share";

/** A short, broad palette for rating at the table — the full wheel lives on the pour sheet. */
export const TABLE_TAGS = [
  "vanilla", "caramel", "honey", "dark-fruit", "citrus", "green-apple", "cherry", "raisin",
  "oak", "nutty", "chocolate", "cinnamon", "black-pepper", "peat", "campfire", "brine", "medicinal", "herbal",
] as const;

async function post(url: string, method: string, body: unknown) {
  return fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

/** Signed-out guest: name + birth date (21+ check, D20), then a 24 h seat. */
export function GuestJoinForm({
  code,
  markets,
  endpoint = "/api/flights/join",
  intro = "Join as a guest — no account needed tonight. Your ratings are kept for 24 hours unless you create one.",
  submitLabel = "Join the tasting",
  closedCopy = "This tasting night is closed or the link is wrong.",
}: {
  code: string;
  markets: ReadonlyArray<{ code: string; label: string }>;
  /** Shared with outings (D22): same 21+ check, same 24 h seat, different table. */
  endpoint?: string;
  intro?: string;
  submitLabel?: string;
  closedCopy?: string;
}) {
  const router = useRouter();
  const [guestName, setGuestName] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [market, setMarket] = useState("US");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await post(endpoint, "POST", { code, guest: { guestName, birthDate, market } }).catch(() => null);
    setBusy(false);
    if (res?.ok) router.refresh();
    else if (res?.status === 403) setError("Whaikey is only for people of legal drinking age where you live.");
    else if (res?.status === 400) setError("Check your name and birth date.");
    else setError(closedCopy);
  }
  return (
    <form onSubmit={submit} className="card flex flex-col gap-3 p-4">
      <p className="text-sm">{intro}</p>
      <label className="flex flex-col gap-1 text-sm">
        First name
        <input value={guestName} onChange={(e) => setGuestName(e.target.value)} maxLength={30} required className="rounded-lg border border-border-subtle bg-surface px-3 py-2" />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Date of birth
        <input type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} required className="rounded-lg border border-border-subtle bg-surface px-3 py-2" />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Where you are
        <select value={market} onChange={(e) => setMarket(e.target.value)} className="rounded-lg border border-border-subtle bg-surface px-3 py-2">
          {markets.map((m) => (
            <option key={m.code} value={m.code}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <p className="text-[11px] text-muted">We check your age and don&rsquo;t store your birth date.</p>
      <button type="submit" disabled={busy} className="btn-primary py-2.5 disabled:opacity-60">
        {busy ? "Joining…" : submitLabel}
      </button>
      {error && (
        <p role="status" className="text-sm text-muted">
          {error}
        </p>
      )}
    </form>
  );
}

export function JoinAsUserButton({ code }: { code: string }) {
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
          const res = await post("/api/flights/join", "POST", { code }).catch(() => null);
          setBusy(false);
          if (res?.status === 409) setNeedsProfile(true);
          else router.refresh();
        }}
        className="btn-primary px-8 py-3 disabled:opacity-60"
      >
        {busy ? "Joining…" : "Take a seat"}
      </button>
      {needsProfile && (
        <p role="status" className="text-center text-sm text-muted">
          Set up your profile first so the table can see your ratings —{" "}
          <a href="/friends/people" className="text-accent">
            it takes a moment
          </a>
          .
        </p>
      )}
    </div>
  );
}

export interface MyEntry {
  rating: number | null;
  flavorTags: Record<string, number> | null;
  note: string | null;
}

/** Rate one glass. Saves on each change; nobody sees it until the host reveals. */
export function RateGlass({ code, slot, initial }: { code: string; slot: string; initial: MyEntry | null }) {
  const [rating, setRating] = useState<number | null>(initial?.rating ?? null);
  const [tags, setTags] = useState<Record<string, number>>(initial?.flavorTags ?? {});
  const [note, setNote] = useState(initial?.note ?? "");
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");
  // Saves run one at a time, each sending the latest full entry, so a slow
  // older request can never land after — and overwrite — a newer one.
  const latest = useRef<MyEntry>({ rating, flavorTags: tags, note });
  const queue = useRef<Promise<void>>(Promise.resolve());

  function save(next: Partial<MyEntry>) {
    latest.current = { ...latest.current, ...next };
    queue.current = queue.current.then(async () => {
      const body = { slot, ...latest.current };
      const res = await post(`/api/flights/${code}/entries`, "PUT", body).catch(() => null);
      setStatus(res?.ok ? "saved" : "error");
    });
    return queue.current;
  }

  return (
    <div className="flex flex-col gap-2">
      <div role="radiogroup" aria-label={`Rating for glass ${slot}`} className="flex items-center gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={rating === n}
            aria-label={`${n} star${n === 1 ? "" : "s"}`}
            onClick={() => {
              setRating(n);
              void save({ rating: n });
            }}
            className="tap-target p-1 text-accent"
          >
            <Star size={22} fill={rating != null && n <= rating ? "currentColor" : "none"} strokeWidth={1.6} aria-hidden />
          </button>
        ))}
      </div>
      <ul className="flex flex-wrap gap-1.5" aria-label={`Descriptors for glass ${slot}`}>
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
                  void save({ flavorTags: next });
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
        onBlur={() => void save({ note })}
        maxLength={500}
        rows={2}
        placeholder="A note for the reveal (optional)"
        aria-label={`Note for glass ${slot}`}
        className="rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm"
      />
      {status !== "idle" && (
        <p role="status" className="text-[11px] text-muted">
          {status === "saved" ? "Saved — hidden until the reveal." : "Couldn't save — check your connection."}
        </p>
      )}
    </div>
  );
}

/** Host: share the QR/link, reveal for everyone (C4), close the night. */
export function HostControls({ code, title, state }: { code: string; title: string; state: "open" | "revealed" | "closed" }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function to(next: "revealed" | "closed") {
    if (busy) return;
    if (next === "revealed" && !window.confirm("Reveal every bottle and everyone's ratings to the table?")) return;
    setBusy(true);
    await post(`/api/flights/${code}/state`, "POST", { to: next }).catch(() => null);
    setBusy(false);
    router.refresh();
  }
  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        onClick={() => void share({ title, text: `Join "${title}" on Whaikey`, url: `${window.location.origin}/f/${code}` })}
        className="btn-secondary px-4 py-2 text-sm"
      >
        Share invite
      </button>
      {state === "open" && (
        <button type="button" disabled={busy} onClick={() => void to("revealed")} className="btn-primary px-4 py-2 text-sm disabled:opacity-60">
          Reveal to the table
        </button>
      )}
      {state === "revealed" && (
        <button type="button" disabled={busy} onClick={() => void to("closed")} className="btn-secondary px-4 py-2 text-sm disabled:opacity-60">
          Close the night
        </button>
      )}
    </div>
  );
}

export function HideNoteButton({ code, entryId }: { code: string; entryId: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={async () => {
        if (!window.confirm("Hide this note from the table?")) return;
        await post(`/api/flights/${code}/entries/${entryId}/hide`, "POST", {}).catch(() => null);
        router.refresh();
      }}
      className="text-[11px] text-muted hover:text-foreground"
    >
      Hide
    </button>
  );
}

/** A guest who has just signed in keeps tonight's ratings. */
export function ClaimSeatButton({ code }: { code: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={async () => {
        await post(`/api/flights/${code}/claim`, "POST", {}).catch(() => null);
        router.refresh();
      }}
      className="btn-primary px-4 py-2 text-sm"
    >
      Keep my guest ratings
    </button>
  );
}

/** The join QR for the table — scanned from the host's phone. */
export function LinkQr({ path, label }: { path: string; label: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    void QRCode.toDataURL(`${window.location.origin}${path}`, { margin: 1, width: 240 }).then(setSrc, () => setSrc(null));
  }, [path]);
  if (!src) return null;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={label} width={160} height={160} className="rounded-lg bg-white p-1" />;
}

/**
 * Everyone at the table sees the reveal when the host makes it (C4): a light
 * poll of the flight's state while it is open, refreshing on change. Stops
 * when the page goes away or the flight is no longer open.
 */
export function RevealWatcher({ code }: { code: string }) {
  const router = useRouter();
  useEffect(() => {
    let live = true;
    const tick = async () => {
      const res = await fetch(`/api/flights/${code}/state`, { cache: "no-store" }).catch(() => null);
      if (!live || !res?.ok) return;
      const { state } = (await res.json()) as { state: string };
      if (state !== "open") router.refresh();
    };
    const id = window.setInterval(() => void tick(), 8000);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, [code, router]);
  return null;
}
