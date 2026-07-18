"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { History, MessageCircle, Plus, Send, Wrench, X } from "lucide-react";

interface ToolCall {
  name: string;
  input: unknown;
  result?: unknown;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCall[] | null;
}

interface ChatSessionSummary {
  id: string;
  title: string | null;
  updatedAt: string;
}

const SUGGESTIONS = [
  "What should I pour tonight?",
  "What's my bar missing?",
  "Explain sherry casks",
];

function SetupCard() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[70dvh] px-6 text-center gap-6">
      <div aria-hidden className="text-5xl drop-shadow-[0_0_24px_rgba(232,161,60,0.25)]">🔌</div>
      <div>
        <h1 className="font-display text-3xl font-semibold tracking-tight">
          The concierge is off duty
        </h1>
        <p className="text-muted mt-3 max-w-sm leading-relaxed">
          AI features are not configured on this server yet.
        </p>
      </div>
      <div className="card p-5 text-left text-sm max-w-md w-full">
        <p className="section-label mb-3">To open the bar</p>
        <ol className="list-decimal list-inside flex flex-col gap-2 text-muted leading-relaxed">
          <li>
            Set <code className="text-accent">ANTHROPIC_API_KEY</code> in your environment (e.g.{" "}
            <code>.env.local</code>).
          </li>
          <li>
            Optionally set <code className="text-accent">WHAIKEY_CHAT_MODEL</code> and{" "}
            <code className="text-accent">WHAIKEY_FAST_MODEL</code>.
          </li>
          <li>Restart the server.</li>
        </ol>
      </div>
    </div>
  );
}

function ToolChips({ toolCalls }: { toolCalls: ToolCall[] }) {
  return (
    <div className="flex flex-wrap gap-1.5 mt-1.5">
      {toolCalls.map((call, i) => (
        <details key={i} className="group">
          <summary className="chip flex items-center gap-1 cursor-pointer list-none px-2.5 py-1 text-[11px] hover:text-foreground">
            <Wrench size={10} strokeWidth={1.8} aria-hidden />
            used: {call.name}
          </summary>
          <pre className="mt-1.5 max-w-full overflow-x-auto rounded-xl bg-surface border border-border-subtle p-2.5 text-[10px] text-muted">
            {JSON.stringify({ input: call.input, result: call.result }, null, 2)}
          </pre>
        </details>
      ))}
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="card-flat rounded-2xl rounded-bl-md! flex items-center gap-1.5 px-4 py-3.5 w-fit">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-accent/70 animate-bounce"
          style={{ animationDelay: `${i * 150}ms` }}
        />
      ))}
      <span className="sr-only">The concierge is thinking…</span>
    </div>
  );
}

export function ChatClient({ aiConfigured }: { aiConfigured: boolean }) {
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const refreshSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/chat/sessions");
      if (!res.ok) return;
      const data = await res.json();
      setSessions(data.sessions ?? []);
    } catch {
      // drawer just stays empty
    }
  }, []);

  useEffect(() => {
    if (!aiConfigured) return;
    let cancelled = false;
    fetch("/api/chat/sessions")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data) setSessions(data.sessions ?? []);
      })
      .catch(() => {
        // drawer just stays empty
      });
    return () => {
      cancelled = true;
    };
  }, [aiConfigured]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, pending]);

  const openSession = useCallback(async (id: string) => {
    setDrawerOpen(false);
    setError(null);
    try {
      const res = await fetch(`/api/chat?sessionId=${encodeURIComponent(id)}`);
      if (!res.ok) return;
      const data = await res.json();
      setSessionId(id);
      setMessages(
        (data.messages ?? []).map((m: ChatMessage) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          toolCalls: m.toolCalls,
        })),
      );
    } catch {
      setError("Couldn't load that conversation.");
    }
  }, []);

  const newChat = useCallback(() => {
    setSessionId(null);
    setMessages([]);
    setError(null);
    setDrawerOpen(false);
  }, []);

  const pickSuggestion = useCallback((text: string) => {
    setInput(text);
    inputRef.current?.focus();
  }, []);

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || pending) return;
      setError(null);
      setInput("");
      setMessages((prev) => [
        ...prev,
        { id: `local-${Date.now()}`, role: "user", content: message },
      ]);
      setPending(true);
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId, message }),
        });
        if (res.status === 503) {
          setError("AI features are not configured on this server.");
          return;
        }
        if (!res.ok) {
          setError("Something went wrong — please try again.");
          return;
        }
        const data = await res.json();
        setSessionId(data.sessionId);
        setMessages((prev) => [
          ...prev,
          {
            id: `assistant-${Date.now()}`,
            role: "assistant",
            content: data.message,
            toolCalls: data.toolCalls,
          },
        ]);
        void refreshSessions();
      } catch {
        setError("Network error — please try again.");
      } finally {
        setPending(false);
      }
    },
    [pending, sessionId, refreshSessions],
  );

  if (!aiConfigured) return <SetupCard />;

  return (
    <div className="flex flex-col h-[calc(100dvh-4rem)] relative">
      {/* Header */}
      <header className="flex items-center justify-between gap-2 pl-4 pr-2 py-3 border-b border-border-subtle">
        <div>
          <h1 className="font-display text-xl font-semibold leading-tight">Concierge</h1>
          <p className="text-[11px] text-muted mt-0.5">Knows your bar. Pours straight answers.</p>
        </div>
        <div className="flex items-center">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="flex items-center justify-center h-11 w-11 rounded-xl text-muted hover:text-foreground hover:bg-surface transition-colors"
            aria-label="Open conversation list"
          >
            <History size={20} strokeWidth={1.8} aria-hidden />
          </button>
          <button
            type="button"
            onClick={newChat}
            className="flex items-center justify-center h-11 w-11 rounded-xl text-muted hover:text-foreground hover:bg-surface transition-colors"
            aria-label="New chat"
          >
            <Plus size={20} strokeWidth={1.8} aria-hidden />
          </button>
        </div>
      </header>

      {/* Session drawer */}
      {drawerOpen && (
        <div className="absolute inset-0 z-20 flex">
          <div className="w-72 max-w-[80%] bg-surface border-r border-border-subtle h-full flex flex-col">
            <div className="flex items-center justify-between pl-4 pr-2 py-2.5 border-b border-border-subtle">
              <span className="section-label">Conversations</span>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close conversation list"
                className="flex items-center justify-center h-11 w-11 rounded-xl text-muted hover:text-foreground hover:bg-surface-raised transition-colors"
              >
                <X size={18} strokeWidth={1.8} aria-hidden />
              </button>
            </div>
            <button
              type="button"
              onClick={newChat}
              className="btn-secondary flex items-center justify-center gap-2 mx-3 mt-3 px-3 py-2.5 text-sm font-medium"
            >
              <Plus size={16} strokeWidth={1.8} aria-hidden /> New chat
            </button>
            <ul className="flex-1 overflow-y-auto p-3 flex flex-col gap-1">
              {sessions.length === 0 && (
                <li className="text-xs text-muted px-1 py-2">No conversations yet.</li>
              )}
              {sessions.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => void openSession(s.id)}
                    className={`w-full text-left rounded-xl px-3 py-2.5 text-sm truncate transition-colors ${
                      s.id === sessionId
                        ? "bg-accent/10 text-accent border border-accent/30"
                        : "hover:bg-surface-raised"
                    }`}
                  >
                    {s.title || "Untitled chat"}
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <button
            type="button"
            aria-label="Close conversation list"
            className="flex-1 bg-black/50"
            onClick={() => setDrawerOpen(false)}
          />
        </div>
      )}

      {/* Thread */}
      <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-3">
        {messages.length === 0 && !pending && (
          <div className="flex flex-col items-center justify-center flex-1 gap-5 text-center">
            <MessageCircle
              size={40}
              strokeWidth={1.8}
              className="text-accent drop-shadow-[0_0_18px_rgba(232,161,60,0.35)]"
              aria-hidden
            />
            <div>
              <p className="font-display text-xl font-semibold">Ask me anything whiskey.</p>
              <p className="text-muted text-sm mt-2 max-w-xs leading-relaxed">
                Your bar, your pours, the wide world of whisk(e)y. Enjoy responsibly.
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => pickSuggestion(s)}
                  className="chip px-4 py-2 text-sm hover:text-foreground"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="self-end max-w-[85%]">
              <div className="rounded-2xl rounded-br-md bg-accent/12 border border-accent/30 px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap">
                {m.content}
              </div>
            </div>
          ) : (
            <div key={m.id} className="self-start max-w-[85%]">
              <div className="card-flat rounded-2xl rounded-bl-md! px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap">
                {m.content}
              </div>
              {m.toolCalls && m.toolCalls.length > 0 && <ToolChips toolCalls={m.toolCalls} />}
            </div>
          ),
        )}

        {pending && (
          <div className="self-start max-w-[85%]">
            <TypingIndicator />
          </div>
        )}

        {error && (
          <p role="alert" className="self-center text-sm text-danger">
            {error}
          </p>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Composer */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
        className="sticky bottom-0 px-4 py-3 border-t border-border-subtle bg-background/95 backdrop-blur"
      >
        <div className="card-flat flex items-end gap-2 p-1.5 focus-within:border-accent/50 transition-colors">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
            rows={1}
            placeholder="Ask the concierge…"
            aria-label="Message the concierge"
            className="flex-1 resize-none rounded-xl bg-transparent px-3 py-2.5 text-[15px] placeholder:text-muted focus:outline-none"
          />
          <button
            type="submit"
            disabled={pending || !input.trim()}
            aria-label="Send message"
            className="btn-primary flex items-center justify-center h-11 w-11 shrink-0 disabled:opacity-40"
          >
            <Send size={18} strokeWidth={1.8} aria-hidden />
          </button>
        </div>
      </form>
    </div>
  );
}
