// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CheersButton } from "@/components/cheers-button";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mockFetchOnce(response: { ok: boolean; status: number; body?: unknown }) {
  const fn = vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status,
    json: async () => response.body,
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("CheersButton", () => {
  it("renders the initial count and cheered state", () => {
    render(<CheersButton pourId="p1" initialCount={3} initialCheered={false} />);
    const button = screen.getByRole("button", { name: /cheers/i });
    expect(button).toHaveTextContent("3");
    expect(button).toHaveAttribute("aria-pressed", "false");
  });

  it("optimistically toggles cheered and increments the count, then confirms with the server count", async () => {
    const fetchMock = mockFetchOnce({ ok: true, status: 200, body: { cheersCount: 5 } });
    render(<CheersButton pourId="p1" initialCount={4} initialCheered={false} />);

    await userEvent.click(screen.getByRole("button", { name: /cheers/i }));

    expect(fetchMock).toHaveBeenCalledWith("/api/social/cheers/p1", { method: "POST" });
    expect(await screen.findByRole("button", { name: /cheers/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /cheers/i })).toHaveTextContent("5");
  });

  it("toggles off with DELETE when already cheered", async () => {
    const fetchMock = mockFetchOnce({ ok: true, status: 200, body: { cheersCount: 2 } });
    render(<CheersButton pourId="p1" initialCount={3} initialCheered />);

    await userEvent.click(screen.getByRole("button", { name: /cheers/i }));

    expect(fetchMock).toHaveBeenCalledWith("/api/social/cheers/p1", { method: "DELETE" });
    expect(await screen.findByRole("button", { name: /cheers/i })).toHaveAttribute("aria-pressed", "false");
  });

  it("reverts the optimistic update on failure", async () => {
    mockFetchOnce({ ok: false, status: 500, body: {} });
    render(<CheersButton pourId="p1" initialCount={4} initialCheered={false} />);

    await userEvent.click(screen.getByRole("button", { name: /cheers/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn.t update/i);
    const button = screen.getByRole("button", { name: /cheers/i });
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(button).toHaveTextContent("4");
  });

  it("shows a claim-handle hint and reverts on 409 profile_required", async () => {
    mockFetchOnce({ ok: false, status: 409, body: { error: "profile_required" } });
    render(<CheersButton pourId="p1" initialCount={4} initialCheered={false} />);

    await userEvent.click(screen.getByRole("button", { name: /cheers/i }));

    const hint = await screen.findByText(/claim a handle to join in/i);
    expect(hint.closest("a")).toHaveAttribute("href", "/friends");
    const button = screen.getByRole("button", { name: /cheers/i });
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(button).toHaveTextContent("4");
  });

  it("shows count only, with no interactive button, when disabled (own note)", () => {
    render(<CheersButton pourId="p1" initialCount={7} initialCheered={false} disabled />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText(/cheers/i)).toBeInTheDocument();
  });
});
