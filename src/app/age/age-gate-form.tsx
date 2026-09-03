"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

/**
 * One question, asked once (PLAN.md §9.1).
 *
 * It asks for a date of birth rather than "are you over 21?", because a yes/no
 * box is a box everyone ticks. It asks where you are because the answer is
 * different in different places, and it says which minimum applies before you
 * answer rather than after — a gate that only tells you the rule once you have
 * failed it is teaching people to lie to it.
 */
const INPUT =
  "w-full rounded-xl border border-border-subtle bg-surface py-3 px-4 text-foreground placeholder:text-muted transition-colors focus:outline-none focus:border-accent/70";

export function AgeGateForm({
  markets,
  minimumsByMarket,
  next,
}: {
  markets: ReadonlyArray<{ code: string; label: string }>;
  minimumsByMarket: Record<string, number>;
  next: string;
}) {
  const router = useRouter();
  const [market, setMarket] = useState(markets[0]?.code ?? "US");
  const [birthDate, setBirthDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const minimum = minimumsByMarket[market] ?? 18;

  async function submit() {
    if (!birthDate) {
      setError("Enter your date of birth.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/age", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ birthDate, market }),
      });
      if (res.status === 403) {
        // The answer is on file now, and the gate page renders the block.
        router.refresh();
        return;
      }
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { details?: string[] } | null;
        setError(data?.details?.[0] ?? "That didn't look like a date. Try again.");
        setSaving(false);
        return;
      }
      router.push(next);
      router.refresh();
    } catch {
      setError("Couldn't save that. Check your connection and try again.");
      setSaving(false);
    }
  }

  return (
    <div className="px-4 py-10 max-w-lg mx-auto w-full flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-semibold">One thing before we start</h1>
        <p className="text-sm text-muted leading-relaxed">
          Whaikey is a whiskey journal, so there&apos;s a legal minimum age and it depends on
          where you are. We ask once and keep the answer.
        </p>
      </header>

      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="flex flex-col gap-2">
          <label htmlFor="age-market" className="section-label">
            Where are you?
          </label>
          <select
            id="age-market"
            value={market}
            onChange={(e) => setMarket(e.target.value)}
            className={INPUT}
          >
            {markets.map((m) => (
              <option key={m.code} value={m.code}>
                {m.label}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted">
            The minimum there is {minimum}.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="age-dob" className="section-label">
            Date of birth
          </label>
          <input
            id="age-dob"
            type="date"
            value={birthDate}
            onChange={(e) => setBirthDate(e.target.value)}
            max={new Date().toISOString().slice(0, 10)}
            className={INPUT}
          />
        </div>

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
          {saving ? "Saving…" : "Continue"}
        </button>
      </form>

      <p className="text-xs text-muted leading-relaxed">
        Whaikey never encourages drinking more, and never rewards drinking often.{" "}
        <Link href="/responsible" className="text-accent font-medium">
          Drinking responsibly
        </Link>{" "}
        has the details and where to get help.
      </p>
    </div>
  );
}
