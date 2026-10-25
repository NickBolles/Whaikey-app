"use client";

import { useId, useState } from "react";

/**
 * The signed-out deletion request (see ./page.tsx).
 *
 * Reuses the support queue (`POST /api/feedback`, its rate limits and its
 * `/admin/feedback` inbox) rather than a table of its own: a request is a
 * message for a person to act on, which is exactly what that queue is. It is
 * tagged by `platform: "deletion-request"` so the operator can pick it out.
 */
export const DELETION_REQUEST_TAG = "deletion-request";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Phase = "idle" | "sending" | "sent";

export function DeletionRequestForm() {
  const [email, setEmail] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const emailId = useId();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const address = email.trim();
    if (!EMAIL.test(address)) {
      setError("Enter the email address your Whaikey account uses.");
      return;
    }
    setPhase("sending");
    setError(null);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          body: `Account deletion request (web form, signed out) for the account using ${address}. Confirm with that address before deleting.`,
          contact: address,
          platform: DELETION_REQUEST_TAG,
        }),
      });
      if (res.status === 429) throw new Error("Too many requests just now — try again in an hour.");
      if (!res.ok) throw new Error("Couldn't send the request. Check your connection and try again.");
      setPhase("sent");
    } catch (err) {
      setPhase("idle");
      setError(err instanceof Error ? err.message : "Couldn't send the request.");
    }
  }

  if (phase === "sent") {
    return (
      <p role="status" className="text-sm text-foreground leading-relaxed">
        Request received. Watch {email.trim()} for a message from us asking you to confirm.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2" noValidate>
      <label htmlFor={emailId} className="text-xs text-muted">
        Account email
      </label>
      <input
        id={emailId}
        type="email"
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        maxLength={200}
        className="w-full rounded-lg border border-border-subtle bg-surface min-h-11 py-2 px-3 text-foreground placeholder:text-muted transition-colors focus:outline-none focus:border-accent/70"
        placeholder="you@example.com"
        required
      />
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={phase === "sending"}
        className="btn-secondary tap-target inline-flex w-fit min-h-11 items-center px-4 text-sm disabled:opacity-60"
      >
        {phase === "sending" ? "Sending…" : "Request deletion"}
      </button>
    </form>
  );
}
