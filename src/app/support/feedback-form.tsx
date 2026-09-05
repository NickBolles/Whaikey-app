"use client";

import { useState } from "react";
import { isNativeApp, platform } from "@/lib/native/platform";

/**
 * The in-app feedback form (PLAN.md §9.7).
 *
 * It attaches the platform and, on a device, the shell version, because the
 * first question about any report is "which build". It asks for a contact line
 * only when signed out, since a signed-in message already has an account
 * attached to it.
 */
export function FeedbackForm() {
  const [body, setBody] = useState("");
  const [contact, setContact] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  async function send() {
    if (body.trim().length < 10) {
      setError("A sentence or two, so there's something to act on.");
      return;
    }
    setState("sending");
    setError(null);
    try {
      const { installedShellVersion } = await import("@/lib/native/manifest");
      const appVersion = isNativeApp() ? await installedShellVersion() : null;
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          body: body.trim(),
          contact: contact.trim() || undefined,
          platform: platform(),
          appVersion: appVersion ?? undefined,
        }),
      });
      if (res.status === 429) {
        setError("Too many messages just now — try again shortly.");
        setState("idle");
        return;
      }
      if (!res.ok) throw new Error(`failed (${res.status})`);
      setState("sent");
    } catch {
      setError("Couldn't send that. Check your connection and try again.");
      setState("idle");
    }
  }

  if (state === "sent") {
    return (
      <div role="status" className="card p-5 flex flex-col gap-2">
        <p className="font-display text-lg font-semibold">Got it</p>
        <p className="text-sm text-muted leading-relaxed">
          Thanks — a person reads these. If you left a way to reach you, you&apos;ll hear back.
        </p>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <div className="flex flex-col gap-2">
        <label htmlFor="feedback-body" className="section-label">
          What happened
        </label>
        <textarea
          id="feedback-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={6}
          placeholder="What you were doing, and what you expected instead."
          className="w-full rounded-xl border border-border-subtle bg-surface py-3 px-4 text-foreground placeholder:text-muted transition-colors focus:outline-none focus:border-accent/70"
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="feedback-contact" className="section-label flex flex-col gap-1">
          How to reach you
          <span className="normal-case tracking-normal text-[10px] opacity-70">
            Optional — leave it out and we&apos;ll read it without replying
          </span>
        </label>
        <input
          id="feedback-contact"
          value={contact}
          onChange={(e) => setContact(e.target.value)}
          placeholder="you@example.com"
          className="w-full rounded-xl border border-border-subtle bg-surface py-3 px-4 text-foreground placeholder:text-muted transition-colors focus:outline-none focus:border-accent/70"
        />
      </div>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={state === "sending"}
        className="btn-primary px-6 py-3.5 font-medium disabled:opacity-60 self-start"
      >
        {state === "sending" ? "Sending…" : "Send"}
      </button>
    </form>
  );
}
