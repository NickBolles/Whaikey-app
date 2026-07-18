"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MessageCircle, Plus, PanelLeft, Send, Wrench, X } from "lucide-react";

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
    <div className="flex flex-col items-center justify-center min-h-[70dvh] px-6 text-center gap-4">
      <div className="text-5xl">🔌</div>
      <h1 className="text-2xl font-bold">AI features are not configured</h1>
      <div className="rounded-xl bg-surface border border-border-subtle p-4 text-left text-sm text-muted max-w-md">
        <p className="mb-2">The concierge needs an Anthropic API key. To enable it:</p>
        <ol className="list-decimal list-inside flex flex-col gap-1">
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
          <summary className="flex items-center gap-1 cursor-pointer list-none rounded-full bg-surface border border-border-subtle px-2 py-0.5 text-[11px] text-muted hover:text-foreground transition-colors">
            <Wrench size={10} aria-hidden />
            used: {call.name}
          </summary>
          <pre className="mt-1 max-w-full overflow-x-auto rounded-lg bg-surface border border-border-subtle p-2 text-[10px] text-muted">
            {JSON.stringify({ input: call.input, result: call.result }, null, 2)}
          </pre>
        </details>
      ))}
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex items-center gap-1 rounded-2xl rounded-bl-sm bg-surface border border-border-subtle px-4 py-3 w-fit">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-muted animate-bounce"
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
      <header className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border-subtle">
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          className="flex items-center gap-2 rounded-lg p-2 hover:bg-surface transition-colors"
          aria-label="Open conversation list"
        >
          <PanelLeft size={18} className="text-accent" aria-hidden />
        </button>
        <div className="flex items-center gap-2 font-semibold">
          <MessageCircle size={18} className="text-accent" aria-hidden />
          Whiskey concierge
        </div>
        <button
          type="button"
          onClick={newChat}
          className="flex items-center gap-1 rounded-lg p-2 hover:bg-surface transition-colors"
          aria-label="New chat"
        >
          <Plus size={18} className="text-accent" aria-hidden />
        </button>
      </header>

      {/* Session drawer */}
      {drawerOpen && (
        <div className="absolute inset-0 z-20 flex">
          <div className="w-72 max-w-[80%] bg-surface border-r border-border-subtle h-full flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
              <span className="font-semibold text-sm">Conversations</span>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close conversation list"
                className="rounded-lg p-1 hover:bg-surface-raised transition-colors"
              >
                <X size={16} aria-hidden />
              </button>
            </div>
            <button
              type="button"
              onClick={newChat}
              className="flex items-center gap-2 mx-3 mt-3 rounded-xl bg-accent text-background font-semibold px-3 py-2 text-sm hover:bg-accent-deep transition-colors"
            >
              <Plus size={16} aria-hidden /> New chat
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
                    className={`w-full text-left rounded-lg px-3 py-2 text-sm truncate transition-colors ${
                      s.id === sessionId
                        ? "bg-surface-raised text-accent"
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
            className="flex-1 bg-black/40"
            onClick={() => setDrawerOpen(false)}
          />
        </div>
      )}

      {/* Thread */}
      <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-3">
        {messages.length === 0 && !pending && (
          <div className="flex flex-col items-center justify-center flex-1 gap-4 text-center">
            <div className="text-4xl">🥃</div>
            <p className="text-muted text-sm max-w-xs">
              Ask about your bar, your pours, or anything whiskey. Enjoy responsibly.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => void send(s)}
                  className="rounded-full bg-surface border border-border-subtle px-4 py-2 text-sm hover:bg-surface-raised transition-colors"
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
              <div className="rounded-2xl rounded-br-sm bg-accent text-background px-4 py-2.5 whitespace-pre-wrap">
                {m.content}
              </div>
            </div>
          ) : (
            <div key={m.id} className="self-start max-w-[85%]">
              <div className="rounded-2xl rounded-bl-sm bg-surface border border-border-subtle px-4 py-2.5 whitespace-pre-wrap">
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
          <p role="alert" className="self-center text-sm text-red-400">
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
        className="flex items-end gap-2 border-t border-border-subtle px-4 py-3"
      >
        <textarea
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
          className="flex-1 resize-none rounded-xl bg-surface border border-border-subtle px-4 py-2.5 text-sm focus:outline-none focus:border-accent"
        />
        <button
          type="submit"
          disabled={pending || !input.trim()}
          aria-label="Send message"
          className="rounded-xl bg-accent text-background p-2.5 disabled:opacity-40 hover:bg-accent-deep transition-colors"
        >
          <Send size={18} aria-hidden />
        </button>
      </form>
    </div>
  );
}
