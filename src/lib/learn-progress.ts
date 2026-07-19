"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Client-side Whiskey School progress: which lesson slugs the user has
 * finished. Stored in localStorage (learning progress is device-local for
 * now — it isn't drinking data and works signed-out). Progress counts
 * lessons completed, never pours poured (product guardrails).
 */

const STORAGE_KEY = "whaikey.learn.completed.v1";
const CHANGE_EVENT = "whaikey:learn-progress";

const EMPTY: ReadonlySet<string> = new Set();

function readRaw(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? "[]";
  } catch {
    return "[]";
  }
}

let cache: { raw: string; value: ReadonlySet<string> } | null = null;

function getSnapshot(): ReadonlySet<string> {
  const raw = readRaw();
  if (!cache || cache.raw !== raw) {
    let slugs: string[] = [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) slugs = parsed.filter((s): s is string => typeof s === "string");
    } catch {
      // corrupted storage — treat as no progress
    }
    cache = { raw, value: new Set(slugs) };
  }
  return cache.value;
}

function getServerSnapshot(): ReadonlySet<string> {
  return EMPTY;
}

function subscribe(onStoreChange: () => void): () => void {
  window.addEventListener("storage", onStoreChange);
  window.addEventListener(CHANGE_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener(CHANGE_EVENT, onStoreChange);
  };
}

function write(slugs: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...slugs].sort()));
  } catch {
    // storage unavailable (private mode) — progress just won't persist
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function markLessonComplete(slug: string): void {
  const current = getSnapshot();
  if (current.has(slug)) return;
  write(new Set([...current, slug]));
}

export function resetLearnProgress(): void {
  write(new Set());
}

export function useLearnProgress(): {
  completed: ReadonlySet<string>;
  markComplete: (slug: string) => void;
} {
  const completed = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const markComplete = useCallback((slug: string) => markLessonComplete(slug), []);
  return { completed, markComplete };
}
