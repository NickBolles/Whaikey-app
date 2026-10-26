// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

const router = { refresh: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { deriveRows, LiveEnrichment, SourcedNotes, statusLine } from "@/components/live-enrichment";
import type { EnrichmentView } from "@/lib/enrich/queue";

const PROFILE = { fruity: 3, floral: 1, grain: 4, sweet: 6, woody: 5, spicy: 3, peaty: 0, feinty: 1 };

function view(over: Partial<NonNullable<EnrichmentView["job"]>> = {}, events: EnrichmentView["events"] = [], fields: Partial<EnrichmentView["fields"]> = {}): EnrichmentView {
  return {
    job: { reason: "new_bottle", state: "running", stepsDone: [], waiting: null, createdAt: new Date().toISOString(), claimedAt: null, finishedAt: null, lastSeq: events.length, ...over },
    events,
    fields: { profile: null, abv: null, ageYears: null, caskTypes: null, mashBill: null, country: null, notes: null, sources: null, ...fields },
  };
}
const ev = (seq: number, kind: string, step: string | null, message: string, data: Record<string, unknown> | null = null) => ({ seq, kind, step, message, data, at: new Date().toISOString() });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  router.refresh.mockReset();
});

describe("deriveRows / statusLine", () => {
  it("tracks steps from the event log", () => {
    const running = view({ stepsDone: ["keyword"] }, [ev(1, "queued", null, "Queued"), ev(2, "step_started", "quick", "Sketching a quick flavor profile")]);
    expect(deriveRows(running).map((r) => r.state)).toEqual(["active", "pending", "pending"]);
    expect(statusLine(running)).toBe("Sketching a quick flavor profile…");

    const done = view(
      { state: "done", stepsDone: ["keyword", "quick", "web"] },
      [
        ev(1, "found", "quick", "Found a flavor profile — sweet, woody and grain lead", { field: "profile" }),
        ev(2, "found", "web", "Found tasting notes", { field: "notes" }),
        ev(3, "found", "web", "Found details — 46% ABV · 12 years", { field: "details" }),
      ],
      { profile: PROFILE, notes: { nose: "Caramel", palate: null, finish: null, leaves: [] }, sources: [{ url: "https://a.com", label: "A" }] },
    );
    const rows = deriveRows(done);
    expect(rows.map((r) => r.state)).toEqual(["found", "found", "found"]);
    expect(rows[0].detail).toBe("Sweet, woody and grain lead");
    expect(rows[1].detail).toBe("From 1 published source");
    expect(rows[2].detail).toBe("46% ABV · 12 years");
    expect(statusLine(done)).toBe("Card complete");

    const nothing = view({ state: "done", stepsDone: ["keyword", "quick", "web"] }, [ev(1, "step_done", "web", "No published notes found for this bottling")]);
    expect(deriveRows(nothing).map((r) => [r.state, r.detail])).toEqual([
      ["none", null],
      ["none", "No published notes found for this bottling"],
      ["none", "Nothing new to add"],
    ]);
  });

  it("explains waiting, errors and failures in plain words", () => {
    expect(statusLine(view({ state: "queued", waiting: "budget" }))).toMatch(/^Queued — we'll finish this soon/);
    expect(statusLine(view({ state: "queued", waiting: "error" }))).toBe("Hit a snag — retrying shortly");
    expect(statusLine(view({ state: "queued" }))).toBe("Queued — checking sources shortly");
    expect(statusLine(view({ state: "failed" }))).toMatch(/daily catalog pass/);
    expect(statusLine({ ...view(), job: null })).toBe("");
  });
});

describe("LiveEnrichment", () => {
  it("polls the feed, fills in what it finds and refreshes the page when done", async () => {
    vi.useFakeTimers();
    const next = view(
      { state: "done", stepsDone: ["keyword", "quick", "web"], lastSeq: 2 },
      [ev(2, "found", "quick", "Found a flavor profile — sweet lead", { field: "profile" })],
      { profile: PROFILE },
    );
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(next), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<LiveEnrichment bottleId="b1" initial={view({ state: "queued" }, [ev(1, "queued", null, "Queued")])} />);
    expect(screen.getByRole("region", { name: "Building this bottle's card" })).toBeTruthy();
    expect(screen.getByText("Live")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/bottles/b1/enrichment?after=1", { cache: "no-store" });
    expect(screen.getByText("Card built")).toBeTruthy();
    expect(screen.getByLabelText("Flavor profile so far")).toBeTruthy();
    expect(router.refresh).toHaveBeenCalled();
  });

  it("keeps polling slowly through errors", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => {
      throw new Error("offline");
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<LiveEnrichment bottleId="b1" initial={view({ state: "queued", waiting: "paused" })} />);
    expect(screen.getByText("Queued")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it("renders nothing without a job", () => {
    const { container } = render(<LiveEnrichment bottleId="b1" initial={{ ...view(), job: null }} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("SourcedNotes", () => {
  it("labels AI-summarised notes and links the sources", () => {
    render(<SourcedNotes notes={{ nose: "Caramel", palate: "Toffee", finish: null, leaves: [] }} sources={[{ url: "https://a.com/r", label: "A Review" }]} />);
    expect(screen.getByText("Caramel")).toBeTruthy();
    expect(screen.queryByText("finish")).toBeNull();
    expect(screen.getByText(/AI summary of published notes/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "A Review" }).getAttribute("href")).toBe("https://a.com/r");
  });
});
