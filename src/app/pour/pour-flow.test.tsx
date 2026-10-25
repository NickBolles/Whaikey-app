// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const push = vi.fn();
const back = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, back, refresh }) }));

let prev: string | null = null;
vi.mock("@/lib/nav-history", () => ({ previousPath: () => prev }));

// The camera slot is exercised on its own; here it only has to hand the sheet
// a bottle the way an exact barcode or a search pick would.
vi.mock("@/components/pour/scan-slot", () => ({
  PourScanSlot: ({ onPick }: { onPick: (b: unknown, m: unknown) => void }) => (
    <div>
      <button type="button" onClick={() => onPick({ id: "blantons", name: "Blanton's Original", distillery: "Buffalo Trace", abv: 46.5 }, { via: "barcode", alternatives: [{ id: "blantons-gold", name: "Blanton's Gold" }] })}>
        fake barcode hit
      </button>
      <button type="button" onClick={() => onPick({ id: "eagle", name: "Eagle Rare 10" }, { via: "search" })}>
        fake search pick
      </button>
    </div>
  ),
}));

import { ToastProvider } from "@/components/toast";
import { PourFlow } from "./pour-flow";

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const fn = vi.fn(impl);
  vi.stubGlobal("fetch", fn);
  return fn;
}

function ok(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function renderFlow(props: Parameters<typeof PourFlow>[0] = {}) {
  return render(
    <ToastProvider>
      <PourFlow userId="u1" {...props} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  prev = null;
  push.mockReset();
  back.mockReset();
  refresh.mockReset();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PourFlow — the 3-tap path", () => {
  it("a prefilled bottle is ★ → Save, private by default, then a toast with Undo and back where you were", async () => {
    prev = "/bar";
    const fetchMock = stubFetch(async (url, init) => {
      const href = String(url);
      if (href.includes("/api/social/prefs")) return { ok: false, json: async () => ({}) } as Response;
      if (href === "/api/pours" && init?.method === "POST") return ok({ pour: { id: "p1" } });
      return ok({});
    });
    renderFlow({ initialBottle: { id: "b1", name: "Test Bourbon" } });
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: "Rate 4 stars" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save pour" }));
    });

    const post = fetchMock.mock.calls.find(([u, i]) => u === "/api/pours" && i?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ bottleId: "b1", rating: 4, visibility: "private", expectedUserId: "u1" });
    expect(back).toHaveBeenCalled();
    expect(screen.getByText(/Poured Test Bourbon/)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /undo/i }));
    });
    expect(fetchMock.mock.calls.some(([u, i]) => String(u) === "/api/pours/p1" && i?.method === "DELETE")).toBe(true);
  });

  it("an exact barcode fills the slot with no confirm step, says so, and offers Not it?", async () => {
    stubFetch(async () => ok({}));
    renderFlow();
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Save pour" })).toBeDisabled();
    expect(screen.getByText("Pick a bottle to save")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "fake barcode hit" }));
    expect(screen.getByTestId("pour-bottle")).toHaveTextContent("Blanton's Original");
    expect(screen.getByText("Barcode match")).toBeInTheDocument();
    expect(screen.getByText(/Matched Blanton's Original/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save pour" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: /Not it\? 1 other/ }));
    fireEvent.click(screen.getByRole("button", { name: "Blanton's Gold" }));
    expect(screen.getByTestId("pour-bottle")).toHaveTextContent("Blanton's Gold");
  });

  it("a scanned bottle can go on the shelf from the sheet, with Undo for a new row", async () => {
    const fetchMock = stubFetch(async (url, init) => {
      if (String(url) === "/api/user-bottles" && init?.method === "POST") return { ok: true, status: 201, json: async () => ({ id: "ub1" }) } as Response;
      return ok({});
    });
    renderFlow();
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "fake barcode hit" }));
    expect(screen.getByRole("link", { name: /Bottle page/ })).toHaveAttribute("href", "/bottles/blantons");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add to bar" }));
    });
    expect(screen.getByRole("button", { name: "In your bar" })).toBeDisabled();
    const post = fetchMock.mock.calls.find(([u, i]) => u === "/api/user-bottles" && i?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ bottleId: "blantons", relationship: "own" });
    expect(screen.getByText(/Added Blanton's Original to your bar/)).toBeInTheDocument();
  });

  it("an unrated pour saves (rating is optional) and goes Home with no in-app history", async () => {
    const fetchMock = stubFetch(async (url, init) => (String(url) === "/api/pours" && init?.method === "POST" ? ok({ pour: { id: "p2" } }) : ok({})));
    renderFlow();
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "fake search pick" }));
    expect(screen.queryByText("Barcode match")).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save pour" }));
    });
    const post = fetchMock.mock.calls.find(([u, i]) => u === "/api/pours" && i?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body)).rating).toBeUndefined();
    expect(push).toHaveBeenCalledWith("/");
  });
});

describe("PourFlow — detail and visibility", () => {
  it("keeps notes, wheel and visibility one tap away, and states the saved default", async () => {
    stubFetch(async (url) => (String(url).includes("/api/social/prefs") ? ok({ defaultPourVisibility: "friends" }) : ok({})));
    renderFlow({ initialBottle: { id: "b1", name: "Test Bourbon" } });
    await act(async () => {});
    expect(screen.getByText(/Friends can see/)).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Who can see this" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Add notes/ }));
    const group = screen.getByRole("group", { name: "Who can see this" });
    expect(within(group).getByRole("button", { name: "Friends" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("tablist", { name: "Note section" })).toBeInTheDocument();
  });

  it("falls back to Only me when prefs can't load", async () => {
    stubFetch(async () => ({ ok: false, json: async () => ({}) }) as Response);
    renderFlow({ initialBottle: { id: "b1", name: "Test Bourbon" } });
    await act(async () => {});
    expect(screen.getByText(/Only me can see/)).toBeInTheDocument();
  });
});

describe("PourFlow — draft (notes before the bottle)", () => {
  it("keeps notes typed before a bottle was chosen across a close and reopen", async () => {
    stubFetch(async () => ok({}));
    const first = renderFlow();
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: /Add notes/ }));
    fireEvent.change(screen.getByPlaceholderText("What do you smell?"), { target: { value: "Cherry and leather" } });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    first.unmount();

    renderFlow();
    await act(async () => {});
    expect(screen.getByText("Draft restored")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("What do you smell?")).toHaveValue("Cherry and leather");

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(window.localStorage.length).toBe(0);
  });

  it("a save inside the debounce window does not write the draft back", async () => {
    stubFetch(async (url, init) => (String(url) === "/api/pours" && init?.method === "POST" ? ok({ pour: { id: "p9" } }) : ok({})));
    renderFlow({ initialBottle: { id: "b1", name: "Test Bourbon" } });
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Rate 3 stars" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save pour" }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    expect(window.localStorage.length).toBe(0);
  });

  it("a draft marked Only me comes back Only me, even when the account default is wider", async () => {
    stubFetch(async (url) => (String(url).includes("/api/social/prefs") ? ok({ defaultPourVisibility: "public" }) : ok({})));
    const first = renderFlow();
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: /Add notes/ }));
    fireEvent.click(within(screen.getByRole("group", { name: "Who can see this" })).getByRole("button", { name: "Only me" }));
    fireEvent.change(screen.getByPlaceholderText("What do you smell?"), { target: { value: "Private thoughts" } });
    // Closed at once: the unmount flush, not the debounce, has to keep it.
    first.unmount();

    renderFlow();
    await act(async () => {});
    expect(screen.getByPlaceholderText("What do you smell?")).toHaveValue("Private thoughts");
    expect(screen.getByText(/Only me can see/)).toBeInTheDocument();
  });
});
