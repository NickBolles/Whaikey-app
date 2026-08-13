// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProfileClaim } from "@/components/profile-claim";

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

describe("ProfileClaim", () => {
  it("claims a handle and shows the confirmation", async () => {
    const fetchMock = mockFetchOnce({
      ok: true,
      status: 201,
      body: {
        userId: "u1",
        handle: "drammer",
        displayName: "Dram Fan",
        avatarUrl: null,
        bio: null,
        homeRegion: null,
        isPublic: false,
        discoverable: true,
        socialEnabled: true,
        createdAt: new Date().toISOString(),
      },
    });
    const onClaimed = vi.fn();
    render(<ProfileClaim suggestedHandle="drammer" onClaimed={onClaimed} />);

    await userEvent.click(screen.getByRole("button", { name: /claim handle/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/social/profile",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ handle: "drammer" }),
      }),
    );
    expect(await screen.findByText("You're @drammer now.")).toBeInTheDocument();
    expect(onClaimed).toHaveBeenCalled();
  });

  it("shows an inline error when the handle is taken", async () => {
    mockFetchOnce({ ok: false, status: 409, body: { error: "handle_taken" } });
    render(<ProfileClaim suggestedHandle="taken" />);

    await userEvent.click(screen.getByRole("button", { name: /claim handle/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/already taken/i);
    expect(screen.queryByText(/now\.$/)).not.toBeInTheDocument();
  });

  it("lowercases input as the user types", async () => {
    mockFetchOnce({ ok: true, status: 201, body: {} });
    render(<ProfileClaim />);

    const input = screen.getByLabelText("Handle");
    await userEvent.type(input, "MixedCase");
    expect(input).toHaveValue("mixedcase");
  });
});
