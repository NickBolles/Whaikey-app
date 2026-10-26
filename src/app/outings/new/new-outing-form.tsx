"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function NewOutingForm({ clubs, defaultClubId, today }: { clubs: Array<{ id: string; name: string }>; defaultClubId: string; today: string }) {
  const router = useRouter();
  const [distilleryName, setDistilleryName] = useState("");
  const [title, setTitle] = useState("");
  const [location, setLocation] = useState("");
  const [visitOn, setVisitOn] = useState(today);
  const [clubId, setClubId] = useState(defaultClubId);
  const [rideReminder, setRideReminder] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveTitle = title.trim() || (distilleryName.trim() ? `Day at ${distilleryName.trim()}` : "");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/outings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: effectiveTitle,
        distilleryName: distilleryName.trim(),
        visitOn,
        rideReminder,
        ...(location.trim() ? { location: location.trim() } : {}),
        ...(clubId ? { clubId } : {}),
      }),
    }).catch(() => null);
    setBusy(false);
    if (res?.status === 201) {
      const { path } = (await res.json()) as { path: string };
      router.push(path);
    } else if (res?.status === 409) setError("Set up your profile on the Friends tab first — guests need to see who's hosting.");
    else setError("Couldn't create the outing — check the distillery name and the date.");
  }

  const field = "rounded-lg border border-border-subtle bg-surface px-3 py-2.5 text-base";
  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        Distillery
        <input value={distilleryName} onChange={(e) => setDistilleryName(e.target.value)} maxLength={80} placeholder="Buffalo Trace" required className={field} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Where (optional)
        <input value={location} onChange={(e) => setLocation(e.target.value)} maxLength={120} placeholder="Frankfort, KY" className={field} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Day
        <input type="date" value={visitOn} onChange={(e) => setVisitOn(e.target.value)} required className={field} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Name (optional)
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} placeholder={distilleryName.trim() ? `Day at ${distilleryName.trim()}` : "Bourbon Trail Saturday"} className={field} />
      </label>
      {clubs.length > 0 && (
        <label className="flex flex-col gap-1 text-sm">
          Club (optional — members get an invite)
          <select value={clubId} onChange={(e) => setClubId(e.target.value)} className={field}>
            <option value="">No club</option>
            {clubs.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="tap-target flex items-center justify-between gap-3 text-sm">
        <span>
          Ride reminder
          <span className="block text-xs text-muted">One card on the outing page about sorting a driver or a car. Dismissible, never a notification.</span>
        </span>
        <input type="checkbox" checked={rideReminder} onChange={(e) => setRideReminder(e.target.checked)} className="h-5 w-5 shrink-0" />
      </label>
      <button type="submit" disabled={busy || distilleryName.trim().length < 2 || !visitOn} className="btn-primary py-3 disabled:opacity-60">
        {busy ? "Planning…" : "Create the outing"}
      </button>
      {error && (
        <p role="status" className="text-sm text-muted">
          {error}
        </p>
      )}
    </form>
  );
}
