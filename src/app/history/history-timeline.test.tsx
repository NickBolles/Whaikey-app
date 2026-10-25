// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";

vi.mock("@/components/pour-share-button", () => ({
  PourShareButton: ({ bottleName }: { bottleName: string }) => <button type="button">Share {bottleName}</button>,
}));

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
vi.mock("@/components/visibility-control", () => ({
  VisibilityControl: ({ onChange }: { onChange?: (v: string) => void }) => (
    <button type="button" onClick={() => onChange?.("public")}>
      make public
    </button>
  ),
}));

import { ToastProvider } from "@/components/toast";
import { HistoryTimeline, type TimelinePour } from "./history-timeline";

function render(ui: ReactElement) {
  return rtlRender(<ToastProvider>{ui}</ToastProvider>);
}

afterEach(cleanup);

function pour(over: Partial<TimelinePour> = {}): TimelinePour {
  return {
    id: over.id ?? "p1",
    bottleId: "b1",
    bottleName: over.bottleName ?? "Test Bourbon",
    rating: over.rating ?? 4,
    servingStyle: over.servingStyle ?? "neat",
    amountMl: over.amountMl ?? 30,
    createdAt: over.createdAt ?? "2026-03-14T18:30:00.000Z",
    visibility: over.visibility ?? "private",
    note: over.note ?? null,
  };
}

describe("HistoryTimeline", () => {
  it("renders every pour row on first paint and after mount", async () => {
    render(
      <HistoryTimeline
        pours={[
          pour({ id: "a", bottleName: "Bottle A" }),
          pour({ id: "b", bottleName: "Bottle B", createdAt: "2026-03-13T18:30:00.000Z" }),
        ]}
      />,
    );
    // A microtask flush lets the mount effect run so day headers appear.
    await act(async () => {});
    expect(screen.getByText("Bottle A")).toBeInTheDocument();
    expect(screen.getByText("Bottle B")).toBeInTheDocument();
  });

  it("groups pours from the same local day under one heading", async () => {
    render(
      <HistoryTimeline
        pours={[
          pour({ id: "a", createdAt: "2026-03-14T14:00:00.000Z" }),
          pour({ id: "b", createdAt: "2026-03-14T20:00:00.000Z" }),
        ]}
      />,
    );
    await act(async () => {});
    // Two same-day pours collapse into a single day <section>.
    const sections = screen.getAllByRole("region").filter((r) => r.getAttribute("aria-label") !== "Notifications");
    expect(sections).toHaveLength(1);
  });

  it("keeps share, visibility and delete behind the row's ⋯ menu (STORYBOARD D9)", () => {
    render(<HistoryTimeline pours={[pour({ bottleName: "Shareable Rye" })]} />);
    expect(screen.queryByRole("button", { name: "Share Shareable Rye" })).not.toBeInTheDocument();
    const more = screen.getByRole("button", { name: "More for Shareable Rye" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Share Shareable Rye" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "All pours of this bottle" })).toHaveAttribute("href", "/history?bottleId=b1");
  });

  it("the row's meta line follows a visibility change made in its menu", () => {
    render(<HistoryTimeline pours={[pour({ bottleName: "Open Rye" })]} />);
    expect(screen.getByText(/only me/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "More for Open Rye" }));
    fireEvent.click(screen.getByRole("button", { name: "make public" }));
    expect(screen.getByText(/· public/)).toBeInTheDocument();
  });

  it("delete hides the row at once and only sends the DELETE when Undo was not pressed", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    try {
      render(<HistoryTimeline pours={[pour({ bottleName: "Gone Rye" })]} />);
      fireEvent.click(screen.getByRole("button", { name: "More for Gone Rye" }));
      fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
      expect(screen.queryByTestId("journal-row")).not.toBeInTheDocument();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /undo/i }));
      });
      expect(screen.getByTestId("journal-row")).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("formats the pour time using Intl (viewer timezone), not a raw ISO string", async () => {
    render(<HistoryTimeline pours={[pour({ createdAt: "2026-03-14T18:30:00.000Z" })]} />);
    await act(async () => {});
    const expected = new Date("2026-03-14T18:30:00.000Z").toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
    expect(screen.getByText(new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeInTheDocument();
  });

  it("edits an entry in place, marks it edited, and Undo PATCHes back the server's previous values", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push(body);
      const undo = calls.length > 1;
      return {
        ok: true,
        json: async () => ({
          pour: { rating: undo ? 4 : 4, servingStyle: undo ? "neat" : "rocks", visibility: "private", editedAt: "2026-03-15T00:00:00.000Z" },
          note: undo ? null : { nose: null, palate: null, finish: null, freeform: "on ice now", flavorTags: null },
          previous: undo ? {} : { servingStyle: "neat", note: { freeform: null } },
        }),
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<HistoryTimeline pours={[pour()]} />);
    fireEvent.click(screen.getByRole("button", { name: "More for Test Bourbon" }));
    fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
    fireEvent.click(screen.getByRole("button", { name: "rocks" }));
    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "on ice now" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(calls[0]).toEqual({ servingStyle: "rocks", note: { freeform: "on ice now" } });
    expect(await screen.findByText("on ice now")).toBeInTheDocument();
    expect(screen.getByText(/edited/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    });
    await waitFor(() => expect(calls[1]).toEqual({ servingStyle: "neat", note: { freeform: null } }));
    await waitFor(() => expect(screen.queryByText("on ice now")).not.toBeInTheDocument());
    vi.unstubAllGlobals();
  });

  it("an edit with nothing changed sends nothing", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<HistoryTimeline pours={[pour()]} />);
    fireEvent.click(screen.getByRole("button", { name: "More for Test Bourbon" }));
    fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});
