"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Check, Undo2, X } from "lucide-react";

/**
 * The app-level toast region with undo (docs/STORYBOARD.md §1.2, review UX-13).
 *
 * "Every reversible mutation confirms with a 4-second toast carrying Undo."
 * One region, mounted once in the root layout, so a toast outlives the
 * navigation that usually follows a mutation, and every screen reports the
 * same way instead of growing its own inline status line.
 *
 * Usage:
 *
 *   const toast = useToast();
 *   // An inverse-action undo: the write already happened; undo reverses it.
 *   toast.show({
 *     message: `Removed ${name}`,
 *     undo: () => fetch(`/api/shelf/${id}`, { method: "POST", ... }).then(assertOk),
 *   });
 *   // A deferred commit: hold the write until the toast closes without undo.
 *   toast.show({
 *     message: "Pour deleted",
 *     undo: () => restoreRowLocally(),
 *     onClose: (reason) => { if (reason !== "undone") void commitDelete(); },
 *   });
 *   toast.error("Couldn't save that. Try again.");
 *
 * `undo` may be async. While it runs the button reads "Undoing…" and the
 * toast will not time out; if it throws (or rejects), the toast is replaced by
 * an error one and `onClose` receives "undo-failed", so the caller can put its
 * optimistic state back. `onClose` fires exactly once per toast.
 */

export type ToastTone = "default" | "success" | "error";

export type ToastCloseReason =
  /** Ran its full time with nobody touching it. */
  | "timeout"
  /** Closed by the × button, Escape, or `dismiss(id)`. */
  | "dismissed"
  /** Undo was pressed and the undo function resolved. */
  | "undone"
  /** Undo was pressed and the undo function threw. The mutation stands. */
  | "undo-failed"
  /** Pushed out by newer toasts (more than MAX_VISIBLE_TOASTS at once). */
  | "replaced";

export interface ToastOptions {
  message: string;
  tone?: ToastTone;
  /** Reverses the mutation this toast reports. Present ⇒ an Undo button. */
  undo?: () => unknown;
  /** A second, non-undo action ("View", "Retry"). Closes the toast when tapped. */
  action?: { label: string; onClick: () => void };
  /** Milliseconds before it closes itself. Paused while hovered or focused. */
  duration?: number;
  onClose?: (reason: ToastCloseReason) => void;
}

export interface ToastApi {
  /** Show a toast; returns its id. A bare string is `{ message }`. */
  show(options: ToastOptions | string): string;
  /** An error toast: longer on screen, no undo. */
  error(message: string, options?: Omit<ToastOptions, "message" | "tone" | "undo">): string;
  dismiss(id: string): void;
}

/** STORYBOARD §1.2: "a 4-second toast carrying Undo". */
export const TOAST_DURATION_MS = 4_000;
/** Errors carry more to read and nothing to undo, so they stay a little longer. */
export const ERROR_TOAST_DURATION_MS = 6_000;
/** Enough to see two quick mutations in a row; more than this is a wall. */
export const MAX_VISIBLE_TOASTS = 3;

interface ToastRecord extends ToastOptions {
  id: string;
  undoing: boolean;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) {
    throw new Error("useToast() needs a <ToastProvider> above it (the root layout mounts one).");
  }
  return api;
}

let nextId = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  // The source of truth for the callbacks below, so they can stay stable
  // (useToast's result is safe in effect deps) and never fire a side effect
  // from inside a state updater, which StrictMode runs twice.
  const toastsRef = useRef<ToastRecord[]>([]);

  const apply = useCallback((next: ToastRecord[]) => {
    toastsRef.current = next;
    setToasts(next);
  }, []);

  const close = useCallback(
    (id: string, reason: ToastCloseReason) => {
      const toast = toastsRef.current.find((t) => t.id === id);
      if (!toast) return;
      apply(toastsRef.current.filter((t) => t.id !== id));
      toast.onClose?.(reason);
    },
    [apply],
  );

  const show = useCallback(
    (input: ToastOptions | string) => {
      const options = typeof input === "string" ? { message: input } : input;
      const id = `toast-${++nextId}`;
      const all = [...toastsRef.current, { ...options, id, undoing: false }];
      const overflow = all.slice(0, Math.max(0, all.length - MAX_VISIBLE_TOASTS));
      apply(all.slice(-MAX_VISIBLE_TOASTS));
      for (const old of overflow) old.onClose?.("replaced");
      return id;
    },
    [apply],
  );

  const error = useCallback<ToastApi["error"]>(
    (message, options) =>
      show({ duration: ERROR_TOAST_DURATION_MS, ...options, message, tone: "error" }),
    [show],
  );

  const runUndo = useCallback(
    async (id: string) => {
      const toast = toastsRef.current.find((t) => t.id === id);
      if (!toast?.undo || toast.undoing) return;
      apply(toastsRef.current.map((t) => (t.id === id ? { ...t, undoing: true } : t)));
      try {
        await toast.undo();
        close(id, "undone");
      } catch {
        close(id, "undo-failed");
        error("Couldn't undo that. It's still saved.");
      }
    },
    [apply, close, error],
  );

  const api = useMemo<ToastApi>(
    () => ({ show, error, dismiss: (id) => close(id, "dismissed") }),
    [show, error, close],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* Always in the DOM: a live region only announces changes to content
          it already contained. Sits above the bottom nav when there is one
          (the nav carries data-app-nav) and near the bottom edge when not. */}
      <section
        aria-label="Notifications"
        aria-live="polite"
        aria-relevant="additions text"
        className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+1rem)] z-[70] px-4 [body:has([data-app-nav])_&]:bottom-[calc(env(safe-area-inset-bottom)+5.5rem)]"
      >
        <ol className="mx-auto flex w-full max-w-md flex-col gap-2">
          {toasts.map((toast) => (
            <ToastItem
              key={toast.id}
              toast={toast}
              onTimeout={() => close(toast.id, "timeout")}
              onDismiss={() => close(toast.id, "dismissed")}
              onUndo={() => void runUndo(toast.id)}
              onAction={() => {
                toast.action?.onClick();
                close(toast.id, "dismissed");
              }}
            />
          ))}
        </ol>
      </section>
    </ToastContext.Provider>
  );
}

function ToastItem({
  toast,
  onTimeout,
  onDismiss,
  onUndo,
  onAction,
}: {
  toast: ToastRecord;
  onTimeout: () => void;
  onDismiss: () => void;
  onUndo: () => void;
  onAction: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const duration = toast.duration ?? (toast.tone === "error" ? ERROR_TOAST_DURATION_MS : TOAST_DURATION_MS);
  const remaining = useRef(duration);
  const timeoutRef = useRef(onTimeout);
  useEffect(() => {
    timeoutRef.current = onTimeout;
  });

  // Paused, not restarted, while a pointer or focus is on it: someone reaching
  // for Undo must not lose it to the clock (WCAG 2.2.1), and an undo in flight
  // must not be timed out from under itself.
  const running = !hovered && !focused && !toast.undoing;
  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    const timer = setTimeout(() => timeoutRef.current(), Math.max(0, remaining.current));
    return () => {
      clearTimeout(timer);
      remaining.current -= Date.now() - started;
    };
  }, [running]);

  const Icon = toast.tone === "error" ? AlertCircle : toast.tone === "success" ? Check : null;

  return (
    <li
      data-toast-tone={toast.tone ?? "default"}
      className="card pointer-events-auto flex min-h-14 items-center gap-2 py-1.5 pl-4 pr-1.5 text-sm shadow-2xl"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onDismiss();
      }}
    >
      {Icon && (
        <Icon
          size={18}
          strokeWidth={1.8}
          aria-hidden
          className={`shrink-0 ${toast.tone === "error" ? "text-danger" : "text-success"}`}
        />
      )}
      <p className="min-w-0 flex-1 py-2 text-foreground">{toast.message}</p>
      {toast.undo && (
        <button
          type="button"
          onClick={onUndo}
          disabled={toast.undoing}
          className="flex h-11 shrink-0 items-center gap-1.5 rounded-xl px-3 font-medium text-accent transition-colors hover:bg-surface-raised disabled:text-muted focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <Undo2 size={16} strokeWidth={1.8} aria-hidden />
          {toast.undoing ? "Undoing…" : "Undo"}
        </button>
      )}
      {toast.action && (
        <button
          type="button"
          onClick={onAction}
          className="flex h-11 shrink-0 items-center rounded-xl px-3 font-medium text-foreground transition-colors hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-muted transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent/60"
      >
        <X size={16} strokeWidth={1.8} aria-hidden />
      </button>
    </li>
  );
}
