"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp } from "lucide-react";

const PROMPTS = ["What should I pour tonight?", "What is my bar missing?", "Pair something with steak"];

export function HomeConcierge({ aiConfigured }: { aiConfigured: boolean }) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const ask = (value: string) => {
    const question = value.trim();
    if (question) router.push(`/chat?q=${encodeURIComponent(question)}`);
  };
  if (!aiConfigured) return <section aria-label="Ask the concierge" className="card p-4"><div className="flex items-start justify-between gap-3"><div><h2 className="font-display text-lg font-semibold">Ask your bar</h2><p className="mt-1 text-sm text-muted">The concierge is not configured on this server yet. Your shelf and pour tools are ready to use.</p></div><span aria-hidden className="text-2xl">✨</span></div></section>;

  return <section aria-label="Ask the concierge" className="card overflow-hidden p-4"><div className="flex items-start justify-between gap-3"><div><h2 className="font-display text-lg font-semibold">Ask your bar</h2><p className="mt-0.5 text-sm text-muted">Get a recommendation, pairing, or a little whiskey wisdom.</p></div><span aria-hidden className="text-2xl">✨</span></div><div className="mt-4 flex flex-wrap gap-2">{PROMPTS.map((prompt) => <button key={prompt} type="button" onClick={() => ask(prompt)} className="chip inline-flex min-h-11 items-center px-3 py-2 text-xs hover:text-foreground">{prompt}</button>)}</div><form className="mt-3 flex items-center gap-2 rounded-xl border border-border-subtle bg-surface-raised/50 p-1.5 focus-within:border-accent/60" onSubmit={(event: FormEvent) => { event.preventDefault(); ask(message); }}><input value={message} onChange={(event) => setMessage(event.target.value)} aria-label="Ask the concierge" placeholder="Ask about a pour, bottle, or pairing…" className="min-w-0 flex-1 bg-transparent px-2 py-2 text-sm placeholder:text-muted focus:outline-none" /><button type="submit" disabled={!message.trim()} aria-label="Ask concierge" className="btn-primary flex min-h-11 min-w-11 shrink-0 items-center justify-center disabled:opacity-40"><ArrowUp size={18} aria-hidden /></button></form></section>;
}
