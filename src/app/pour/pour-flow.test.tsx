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

/** The tasting-notes section's default open state is a product decision that
 * has flipped before (#65); these tests only care that the section IS open. */
function ensureNotesOpen() {
  const toggle = screen.getByRole("button", { name: /tasting notes/i });
  if (toggle.getAttribute("aria-expanded") === "false") fireEvent.click(toggle);
}

describe("PourFlow — visibility (US-6)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to the user's saved preference and renders the 4 chips under Tasting notes", async () => {
    stubFetch(async (url) => {
      if (String(url).includes("/api/social/prefs")) {
        return { ok: true, json: async () => ({ defaultPourVisibility: "friends", allowComments: true }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    render(<PourFlow initialBottle={{ id: "b1", name: "Test Bourbon" }} />);

    await act(async () => {});

    ensureNotesOpen();

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

    ensureNotesOpen();
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
