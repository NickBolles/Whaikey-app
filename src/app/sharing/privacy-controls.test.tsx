// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PrivacyControls } from "@/app/sharing/privacy-controls";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mockFetchOnce(response: { ok: boolean; status?: number; body?: unknown }) {
  const fn = vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 400),
    json: async () => response.body,
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("PrivacyControls", () => {
  it("shows only the visibility control and a note when there's no profile", () => {
    render(
      <PrivacyControls
        hasProfile={false}
        initialDefaultVisibility="private"
        initialAllowComments={true}
        initialSocialEnabled={false}
      />,
    );
    expect(screen.getByText("Default visibility for new pours")).toBeInTheDocument();
    expect(screen.getByText(/appear once you set up a profile/i)).toBeInTheDocument();
    expect(screen.queryByText("Allow comments")).not.toBeInTheDocument();
    // The US-11 bulk reset is a safety action and never requires a profile —
    // an S1 sharer with active bearer links can revoke everything in one tap.
    expect(screen.getByText("Step back from social")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Make everything private" })).toBeInTheDocument();
  });

  it("requires an inline confirm before running the privacy reset, then calls the reset route", async () => {
    const fetchMock = mockFetchOnce({ ok: true, body: { done: true } });
    render(
      <PrivacyControls
        hasProfile={true}
        initialDefaultVisibility="friends"
        initialAllowComments={true}
        initialSocialEnabled={true}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Make everything private" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/nothing is deleted/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Yes, make everything private" }));

    expect(fetchMock).toHaveBeenCalledWith("/api/social/privacy-reset", { method: "POST" });
    expect(await screen.findByText(/social is off/i)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Turn social back on" })).toBeInTheDocument();
  });

  it("cancels the confirm without calling the reset route", async () => {
    const fetchMock = mockFetchOnce({ ok: true, body: { done: true } });
    render(
      <PrivacyControls
        hasProfile={true}
        initialDefaultVisibility="private"
        initialAllowComments={true}
        initialSocialEnabled={true}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Make everything private" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Make everything private" })).toBeInTheDocument();
  });

  it("re-enables social via PATCH when social is off", async () => {
    const fetchMock = mockFetchOnce({ ok: true, body: { socialEnabled: true } });
    render(
      <PrivacyControls
        hasProfile={true}
        initialDefaultVisibility="private"
        initialAllowComments={true}
        initialSocialEnabled={false}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Turn social back on" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/social/profile",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ socialEnabled: true }),
      }),
    );
    expect(await screen.findByRole("button", { name: "Make everything private" })).toBeInTheDocument();
  });
});
