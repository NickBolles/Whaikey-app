// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isFreshDocumentLoad,
  markPopNavigation,
  previousPath,
  recordNavigation,
  resetNavHistoryForTests,
  resetNavigation,
  subscribeNavigation,
} from "@/lib/nav-history";

afterEach(() => {
  resetNavHistoryForTests();
  vi.restoreAllMocks();
});

describe("nav history trail", () => {
  it("has nothing behind the first page of a fresh load", () => {
    resetNavigation("/bottles/eagle-rare-10");
    expect(previousPath()).toBeNull();
  });

  it("remembers the page an in-app navigation came from", () => {
    resetNavigation("/search");
    recordNavigation("/bottles/eagle-rare-10");
    expect(previousPath()).toBe("/search");
  });

  it("unwinds on back, so the next back names the page before that", () => {
    resetNavigation("/");
    recordNavigation("/search");
    recordNavigation("/bottles/eagle-rare-10");

    markPopNavigation();
    recordNavigation("/search");
    expect(previousPath()).toBe("/");
  });

  it("unwinds several entries at once for a multi-step history jump", () => {
    resetNavigation("/");
    recordNavigation("/search");
    recordNavigation("/bottles/eagle-rare-10");
    recordNavigation("/bottles/eagle-rare-10/compare");

    markPopNavigation();
    recordNavigation("/");
    expect(previousPath()).toBeNull();
  });

  it("treats a pop to a page not in the trail as a forward", () => {
    resetNavigation("/");
    recordNavigation("/search");
    markPopNavigation();
    recordNavigation("/");
    markPopNavigation();
    recordNavigation("/search");
    expect(previousPath()).toBe("/");
  });

  it("treats a link back to an earlier page as a new step, not a back", () => {
    resetNavigation("/");
    recordNavigation("/search");
    recordNavigation("/"); // a tap on the Home tab, not history traversal
    expect(previousPath()).toBe("/search");
  });

  it("ignores a repeat of the current page (a query-string change, a refresh)", () => {
    resetNavigation("/search");
    recordNavigation("/bottles/eagle-rare-10");
    recordNavigation("/bottles/eagle-rare-10");
    expect(previousPath()).toBe("/search");
  });

  it("keeps its trail across a page reload (a fresh module reading sessionStorage)", async () => {
    resetNavigation("/");
    recordNavigation("/history");

    vi.resetModules();
    const reloaded = await import("@/lib/nav-history");
    expect(reloaded.previousPath()).toBe("/");
  });

  it("notifies subscribers when the trail changes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeNavigation(listener);
    resetNavigation("/");
    recordNavigation("/search");
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    recordNavigation("/bar");
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("isFreshDocumentLoad", () => {
  it("is true for a plain navigation and false for a reload or history traversal", () => {
    const spy = vi.spyOn(performance, "getEntriesByType");
    spy.mockReturnValue([{ type: "navigate" }] as unknown as PerformanceEntryList);
    expect(isFreshDocumentLoad()).toBe(true);
    spy.mockReturnValue([{ type: "reload" }] as unknown as PerformanceEntryList);
    expect(isFreshDocumentLoad()).toBe(false);
    spy.mockReturnValue([{ type: "back_forward" }] as unknown as PerformanceEntryList);
    expect(isFreshDocumentLoad()).toBe(false);
  });

  it("assumes fresh when the browser cannot say — it only costs the history label", () => {
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([]);
    expect(isFreshDocumentLoad()).toBe(true);
  });
});
