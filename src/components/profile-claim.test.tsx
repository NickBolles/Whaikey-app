// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProfileClaim } from "@/components/profile-claim";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

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
  it("claims a handle and shows the confirmation (no display name typed => none sent)", async () => {
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

    // Backward-compatible: existing call sites that pass no suggested display
    // name POST exactly what they always did — the server falls back to the
    // account name.
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

  it("pre-fills the display name and sends it with the claim", async () => {
    const fetchMock = mockFetchOnce({
      ok: true,
      status: 201,
      body: { userId: "u1", handle: "drammer", displayName: "Dram Fan" },
    });
    render(<ProfileClaim suggestedHandle="drammer" suggestedDisplayName="Dram Fan" />);

    expect(screen.getByLabelText("Display name")).toHaveValue("Dram Fan");
    await userEvent.click(screen.getByRole("button", { name: /claim handle/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/social/profile",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ handle: "drammer", displayName: "Dram Fan" }),
      }),
    );
  });

  it("sends an edited display name, trimmed", async () => {
    const fetchMock = mockFetchOnce({
      ok: true,
      status: 201,
      body: { userId: "u1", handle: "drammer", displayName: "The Dram Fan" },
    });
    render(<ProfileClaim suggestedHandle="drammer" suggestedDisplayName="Dram Fan" />);

    const nameInput = screen.getByLabelText("Display name");
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "  The Dram Fan  ");
    await userEvent.click(screen.getByRole("button", { name: /claim handle/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/social/profile",
      expect.objectContaining({
        body: JSON.stringify({ handle: "drammer", displayName: "The Dram Fan" }),
      }),
    );
  });

  it("omits the display name when the field is cleared", async () => {
    const fetchMock = mockFetchOnce({ ok: true, status: 201, body: { userId: "u1", handle: "drammer" } });
    render(<ProfileClaim suggestedHandle="drammer" suggestedDisplayName="Dram Fan" />);

    await userEvent.clear(screen.getByLabelText("Display name"));
    await userEvent.click(screen.getByRole("button", { name: /claim handle/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/social/profile",
      expect.objectContaining({
        body: JSON.stringify({ handle: "drammer" }),
      }),
    );
  });

  it("shows an inline error when the handle is taken", async () => {
    mockFetchOnce({ ok: false, status: 409, body: { error: "handle_taken" } });
    render(<ProfileClaim suggestedHandle="taken" />);

    await userEvent.click(screen.getByRole("button", { name: /claim handle/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/already taken/i);
    expect(screen.queryByText(/now\.$/)).not.toBeInTheDocument();
  });

  it("lowercases handle input as the user types, but not the display name", async () => {
    mockFetchOnce({ ok: true, status: 201, body: {} });
    render(<ProfileClaim />);

    const handleInput = screen.getByLabelText("Handle");
    await userEvent.type(handleInput, "MixedCase");
    expect(handleInput).toHaveValue("mixedcase");

    const nameInput = screen.getByLabelText("Display name");
    await userEvent.type(nameInput, "Mixed Case");
    expect(nameInput).toHaveValue("Mixed Case");
  });
});
