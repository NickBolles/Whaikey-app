// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, renderHook, act } from "@testing-library/react";
import { markLessonComplete, resetLearnProgress, useLearnProgress } from "@/lib/learn-progress";

beforeEach(() => {
  window.localStorage.clear();
  resetLearnProgress();
});
afterEach(cleanup);

describe("useLearnProgress", () => {
  it("starts empty and records completed lessons", () => {
    const { result } = renderHook(() => useLearnProgress());
    expect(result.current.completed.size).toBe(0);

    act(() => result.current.markComplete("what-is-whiskey"));
    expect(result.current.completed.has("what-is-whiskey")).toBe(true);

    act(() => result.current.markComplete("major-styles"));
    expect(result.current.completed.size).toBe(2);
  });

  it("is idempotent for repeat completions", () => {
    const { result } = renderHook(() => useLearnProgress());
    act(() => {
      result.current.markComplete("what-is-whiskey");
      result.current.markComplete("what-is-whiskey");
    });
    expect(result.current.completed.size).toBe(1);
  });

  it("persists to localStorage and hydrates a fresh hook", () => {
    markLessonComplete("peat-and-smoke");
    const { result } = renderHook(() => useLearnProgress());
    expect(result.current.completed.has("peat-and-smoke")).toBe(true);
  });

  it("survives corrupted storage", () => {
    window.localStorage.setItem("whaikey.learn.completed.v1", "not json{");
    const { result } = renderHook(() => useLearnProgress());
    expect(result.current.completed.size).toBe(0);
    act(() => result.current.markComplete("what-is-whiskey"));
    expect(result.current.completed.has("what-is-whiskey")).toBe(true);
  });
});
