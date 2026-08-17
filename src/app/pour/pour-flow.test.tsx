// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PourFlow } from "./pour-flow";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const fn = vi.fn(impl);
  vi.stubGlobal("fetch", fn);
  return fn;
}


/**
 * US-6 (docs/SOCIAL.md): the visibility selector lives behind "add detail",
 * so it is never a tap the core loop has to make.
 */
function openDetail() {
  const toggle = screen.getByRole("button", { name: /Add detail/ });
  if (toggle.getAttribute("aria-expanded") === "false") fireEvent.click(toggle);
}

describe("PourFlow — visibility (US-6)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the selector behind 'add detail', summarising the saved default", async () => {
    stubFetch(async (url) => {
      if (String(url).includes("/api/social/prefs")) {
        return { ok: true, json: async () => ({ defaultPourVisibility: "friends", allowComments: true }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    render(<PourFlow initialBottle={{ id: "b1", name: "Test Bourbon" }} />);
    await act(async () => {});

    // Closed by default — logging a pour costs no visibility tap — but the
    // row still states what the pour is set to.
    expect(screen.getByRole("button", { name: /Add detail/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByRole("button", { name: /Add detail/ })).toHaveTextContent("Friends");
    expect(screen.queryByRole("group", { name: "Who can see this" })).not.toBeInTheDocument();
  });

  it("defaults to the user's saved preference and renders the 4 chips behind add detail", async () => {
    stubFetch(async (url) => {
      if (String(url).includes("/api/social/prefs")) {
        return { ok: true, json: async () => ({ defaultPourVisibility: "friends", allowComments: true }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    render(<PourFlow initialBottle={{ id: "b1", name: "Test Bourbon" }} />);

    await act(async () => {});
    openDetail();

    expect(screen.getByText("Who can see this")).toBeInTheDocument();
    const group = screen.getByRole("group", { name: "Who can see this" });
    expect(group).toHaveTextContent("Only me");
    expect(group).toHaveTextContent("Friends");
    expect(group).toHaveTextContent("Followers");
    expect(group).toHaveTextContent("Public");
    expect(screen.getByRole("button", { name: "Friends" })).toHaveAttribute("aria-pressed", "true");
  });

  it("falls back to Only me when the prefs fetch fails, and submits the chosen visibility", async () => {
    const fetchMock = stubFetch(async (url) => {
      const href = String(url);
      if (href.includes("/api/social/prefs")) return { ok: false, json: async () => ({}) } as Response;
      if (href.includes("/api/pours")) {
        return { ok: true, json: async () => ({ pour: { id: "p1" } }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    render(<PourFlow initialBottle={{ id: "b1", name: "Test Bourbon" }} />);
    await act(async () => {});
    openDetail();

    expect(screen.getByRole("button", { name: "Only me" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Public" }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save pour/i }));
    });

    const pourCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/pours") && !String(url).includes("prefs"));
    expect(pourCall).toBeDefined();
    const body = JSON.parse((pourCall![1] as RequestInit).body as string);
    expect(body.visibility).toBe("public");
  });
});

describe("PourFlow — one sheet, no wizard", () => {
  function renderWithBottle() {
    stubFetch(async (url) => {
      if (String(url).includes("/api/pours") && !String(url).includes("prefs")) {
        return { ok: true, json: async () => ({ pour: { id: "p1" } }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });
    render(<PourFlow initialBottle={{ id: "b1", name: "Test Bourbon" }} />);
  }

  it("keeps Save live in the header from the first tap", async () => {
    renderWithBottle();
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("asks for nothing but the bottle: no visibility tap in the core loop", async () => {
    renderWithBottle();
    await act(async () => {});
    // The wheel, the tabs, and the rating are all here; visibility is not.
    expect(screen.getByRole("application", { name: "Flavor wheel" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Who can see this" })).not.toBeInTheDocument();
  });

  it("shows nose/palate/finish as tabs over one persistent wheel, with note counts", async () => {
    renderWithBottle();
    await act(async () => {});

    // One wheel, always visible — no disclosure to open.
    expect(screen.getByRole("application", { name: "Flavor wheel" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /tasting notes/i })).not.toBeInTheDocument();

    // Typing into the active tab counts the flavors its text names.
    fireEvent.change(screen.getByPlaceholderText("What do you smell?"), {
      target: { value: "vanilla and charred oak" },
    });
    expect(screen.getByRole("tab", { name: /Nose/ })).toHaveTextContent("Nose · 2");

    // Coverage is visible without switching; switching swaps the textarea.
    fireEvent.click(screen.getByRole("tab", { name: /Palate/ }));
    expect(screen.getByPlaceholderText("What do you taste?")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Nose/ })).toHaveTextContent("Nose · 2");
  });

  it("logs the pour without notes in one tap, dropping any half-typed note", async () => {
    const fetchMock = stubFetch(async (url) => {
      if (String(url).includes("/api/pours") && !String(url).includes("prefs")) {
        return { ok: true, json: async () => ({ pour: { id: "p1" } }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });
    render(<PourFlow initialBottle={{ id: "b1", name: "Test Bourbon" }} />);
    await act(async () => {});

    fireEvent.change(screen.getByPlaceholderText("What do you smell?"), {
      target: { value: "half a thought" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Just drinking/ }));
    });

    const pourCall = fetchMock.mock.calls.find(
      ([url]) => String(url).includes("/api/pours") && !String(url).includes("prefs"),
    );
    expect(pourCall).toBeDefined();
    const body = JSON.parse((pourCall![1] as RequestInit).body as string);
    expect(body.note).toBeUndefined();
    expect(body.rating).toBeUndefined();
    expect(body.bottleId).toBe("b1");
    expect(screen.getByRole("heading", { name: "Poured." })).toBeInTheDocument();
  });

  it("sends who you shared it with as pour context", async () => {
    const fetchMock = stubFetch(async (url) => {
      if (String(url).includes("/api/pours") && !String(url).includes("prefs")) {
        return { ok: true, json: async () => ({ pour: { id: "p1" } }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });
    render(<PourFlow initialBottle={{ id: "b1", name: "Test Bourbon" }} />);
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: "People" }));
    fireEvent.change(screen.getByPlaceholderText(/Who was there/), {
      target: { value: "Sasha" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save pour/i }));
    });

    const pourCall = fetchMock.mock.calls.find(
      ([url]) => String(url).includes("/api/pours") && !String(url).includes("prefs"),
    );
    const body = JSON.parse((pourCall![1] as RequestInit).body as string);
    expect(body.context).toEqual({ companions: "Sasha" });
  });
});
