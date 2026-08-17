"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp } from "lucide-react";

/**
 * Compact concierge entry for the bottom of Home: a single input that hands
 * the question off to /chat. Deliberately quiet — the hero owns the page's
 * one accent moment, so the submit button stays a bordered surface control.
 */
export function HomeConcierge({ aiConfigured }: { aiConfigured: boolean }) {
  const router = useRouter();
  const [message, setMessage] = useState("");

  const ask = (value: string) => {
    const question = value.trim();
    if (question) router.push(`/chat?q=${encodeURIComponent(question)}`);
  };

  if (!aiConfigured) {
    return (
      <section aria-label="Ask about your bar" className="card-flat flex items-center gap-3 px-4 py-3">
        <span aria-hidden className="text-lg">
          ✨
        </span>
        <p className="text-sm text-muted">
          The concierge isn’t configured on this server yet — your shelf and pour tools all work
          without it.
        </p>
      </section>
    );
  }

  return (
    <section aria-label="Ask about your bar" className="card p-2.5">
      <form
        className="flex items-center gap-2"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          ask(message);
        }}
      >
        <span aria-hidden className="pl-1.5 text-lg">
          ✨
        </span>
        <input
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          aria-label="Ask about your bar"
          placeholder="Ask about your bar — a pour, a bottle, a pairing…"
          className="min-w-0 flex-1 bg-transparent px-1 py-2.5 text-sm placeholder:text-muted focus:outline-none"
        />
        <button
          type="submit"
          disabled={!message.trim()}
          aria-label="Ask concierge"
          className="btn-secondary flex min-h-11 min-w-11 shrink-0 items-center justify-center disabled:opacity-40"
        >
          <ArrowUp size={18} strokeWidth={1.8} aria-hidden />
        </button>
      </form>
    </section>
  );
}
