// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FriendFinderCard } from "@/app/friends/friend-finder-card";

// The QR pair reaches for canvas / native seams that don't exist in jsdom —
// this card's own concern is the phone settings.
vi.mock("@/components/friend-qr", () => ({ FriendQr: () => null }));
vi.mock("@/components/qr-scan-button", () => ({ QrScanButton: () => null }));

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

const optInSwitch = () => screen.getByRole("switch", { name: "Let people find me by phone" });

describe("FriendFinderCard phone opt-in (docs/SOCIAL.md D8 as amended)", () => {
  it("never preselects discovery on the add form", () => {
    render(<FriendFinderCard handle="me" initialPhoneLast2={null} initialPhoneDiscoverable={false} />);
    expect(optInSwitch()).toHaveAttribute("aria-checked", "false");
  });

  it("removing a discoverable number resets the add form's opt-in to off", async () => {
    mockFetchOnce({ ok: true, body: { removed: true } });
    render(<FriendFinderCard handle="me" initialPhoneLast2="23" initialPhoneDiscoverable={true} />);

    await userEvent.click(screen.getByRole("button", { name: "Remove" }));

    // The add form is back — and a replacement save must require a fresh
    // opt-in, not inherit the removed number's discoverability.
    expect(await screen.findByLabelText("Phone number")).toBeInTheDocument();
    expect(optInSwitch()).toHaveAttribute("aria-checked", "false");
  });

  it("replacing a number re-opens the form with discovery off, whatever the previous save opted into", async () => {
    render(<FriendFinderCard handle="me" initialPhoneLast2="23" initialPhoneDiscoverable={true} />);

    await userEvent.click(screen.getByRole("button", { name: "Replace number" }));

    expect(await screen.findByLabelText("Phone number")).toBeInTheDocument();
    expect(optInSwitch()).toHaveAttribute("aria-checked", "false");
  });
});
