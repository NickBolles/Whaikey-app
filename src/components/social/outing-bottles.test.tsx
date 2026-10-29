import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/pour/scan-slot", () => ({
  PourScanSlot: ({ onPick }: { onPick: (b: { id: string; name: string }, m: { via: string }) => void }) => (
    <button type="button" onClick={() => onPick({ id: "b1", name: "Eagle Rare 10" }, { via: "barcode" })}>
      fake scan
    </button>
  ),
}));

import { OutingBottleBoard } from "./outing-bottles";
import type { OutingBoardBottle } from "@/lib/outings";

const bottle = (over: Partial<OutingBoardBottle> = {}): OutingBoardBottle => ({
  key: "b:b1",
  entryId: "e1",
  label: "Eagle Rare 10",
  bottleId: "b1",
  addedBy: "@sam",
  addedByMe: false,
  votes: [
    { who: "@sam", mine: false, rating: 4, note: "Cherry cola", tags: ["Vanilla"] },
    { who: "You", mine: true, rating: 5, note: null, tags: [] },
  ],
  notYet: ["@lee"],
  average: 4.5,
  groupTags: ["Vanilla", "Oak"],
  favourite: true,
  mine: { id: "t1", rating: 5, flavorTags: null, note: null },
  ...over,
});

describe("OutingBottleBoard", () => {
  beforeEach(() => {
    window.localStorage.clear();
    refresh.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows everyone's verdict, the group average, the favourite and who hasn't rated — never amounts", () => {
    const { container } = render(<OutingBottleBoard code="abc123def4" board={[bottle()]} canAdd canPour />);
    expect(screen.getByText("Group favourite")).toBeTruthy();
    expect(screen.getByLabelText("Group average 4.5 of 5")).toBeTruthy();
    expect(screen.getByText("Not yet: @lee")).toBeTruthy();
    expect(screen.getByText(/Cherry cola/)).toBeTruthy();
    expect(screen.getByText(/sees each other.s ratings and notes/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Log a pour →" }).getAttribute("href")).toBe("/pour?bottleId=b1");
    expect(container.textContent).not.toMatch(/\bml\b|\boz\b|pours? (logged|count)|streak/i);
  });

  it("adds a scanned bottle for the group", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "e2", existed: false }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<OutingBottleBoard code="abc123def4" board={[]} canAdd canPour />);
    fireEvent.click(screen.getByRole("button", { name: "Add a bottle" }));
    fireEvent.click(screen.getByRole("button", { name: "fake scan" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Added Eagle Rare 10 for the group."));
    expect(fetchMock).toHaveBeenCalledWith("/api/outings/abc123def4/bottles", expect.objectContaining({ method: "POST", body: JSON.stringify({ bottleId: "b1" }) }));
    expect(refresh).toHaveBeenCalled();
  });

  it("offline: the add is queued, shown as pending, and sent when the signal is back", async () => {
    let online = false;
    const fetchMock = vi.fn(async () => {
      if (!online) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify({ id: "e2", existed: false }), { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<OutingBottleBoard code="abc123def4" board={[]} canAdd canPour={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Add a bottle" }));
    fireEvent.change(screen.getByLabelText(/add it by name/), { target: { value: "Cask 1142 sample" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.getByText("Pending — will add when online")).toBeTruthy());
    online = true;
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(screen.queryByText("Pending — will add when online")).toBeNull());
    expect(refresh).toHaveBeenCalled();
  });

  it("rates a bottle: edits your own tasting in place", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<OutingBottleBoard code="abc123def4" board={[bottle({ favourite: false })]} canAdd canPour />);
    fireEvent.click(screen.getByRole("button", { name: "Edit my rating" }));
    fireEvent.click(screen.getByRole("radio", { name: "3 stars" }));
    fireEvent.click(screen.getByRole("button", { name: "Update my rating" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Rated Eagle Rare 10."));
    expect(fetchMock).toHaveBeenCalledWith("/api/outings/abc123def4/tastings/t1", expect.objectContaining({ method: "PATCH" }));
  });

  it("a new rating posts a tasting against the bottle; read-only once the outing ends", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<OutingBottleBoard code="abc123def4" board={[bottle({ mine: null, bottleId: null })]} canAdd canPour />);
    fireEvent.click(screen.getByRole("button", { name: "Rate" }));
    fireEvent.click(screen.getByRole("button", { name: "Save my rating" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body)).toMatchObject({ label: "Eagle Rare 10" });
    rerender(<OutingBottleBoard code="abc123def4" board={[bottle()]} canAdd={false} canPour />);
    expect(screen.queryByRole("button", { name: "Add a bottle" })).toBeNull();
    expect(screen.queryByRole("button", { name: /rating|Rate/ })).toBeNull();
  });
});
