// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DiscoveryPanel } from "@/app/friends/discovery-settings";

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

async function submitPhone(number = "+15551234567") {
  await userEvent.type(screen.getByLabelText("Phone number"), number);
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
}

describe("DiscoveryPanel contents", () => {
  it("shows the phone form, the honest storage copy, and the privacy link", () => {
    render(<DiscoveryPanel initialPhoneLast2={null} initialPhoneDiscoverable={false} />);

    expect(screen.getByLabelText("Phone number")).toBeInTheDocument();
    expect(screen.getByText(/stored scrambled and never shown to anyone/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /privacy & sharing/i })).toHaveAttribute("href", "/sharing");
  });
});

describe("DiscoveryPanel phone opt-in (docs/SOCIAL.md D8 as amended)", () => {
  it("never preselects discovery on the add form", () => {
    render(<DiscoveryPanel initialPhoneLast2={null} initialPhoneDiscoverable={false} />);
    expect(optInSwitch()).toHaveAttribute("aria-checked", "false");
  });

  it("posts discoverable only after the explicit toggle", async () => {
    const fetchMock = mockFetchOnce({ ok: true, body: { phoneLast2: "67", phoneDiscoverable: true } });
    render(<DiscoveryPanel initialPhoneLast2={null} initialPhoneDiscoverable={false} />);

    await userEvent.click(optInSwitch());
    await submitPhone();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/social/phone",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ phone: "+15551234567", discoverable: true }),
      }),
    );
    expect(await screen.findByText(/•••• ••67 · discoverable/)).toBeInTheDocument();
  });

  it("posts discoverable: false when the toggle was left alone", async () => {
    const fetchMock = mockFetchOnce({ ok: true, body: { phoneLast2: "67", phoneDiscoverable: false } });
    render(<DiscoveryPanel initialPhoneLast2={null} initialPhoneDiscoverable={false} />);

    await submitPhone();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/social/phone",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ phone: "+15551234567", discoverable: false }),
      }),
    );
    expect(await screen.findByText(/•••• ••67 · not discoverable/)).toBeInTheDocument();
  });

  it("removing a discoverable number resets the add form's opt-in to off", async () => {
    mockFetchOnce({ ok: true, body: { removed: true } });
    render(<DiscoveryPanel initialPhoneLast2="23" initialPhoneDiscoverable={true} />);

    await userEvent.click(screen.getByRole("button", { name: "Remove" }));

    // The add form is back — and a replacement save must require a fresh
    // opt-in, not inherit the removed number's discoverability.
    expect(await screen.findByLabelText("Phone number")).toBeInTheDocument();
    expect(optInSwitch()).toHaveAttribute("aria-checked", "false");
  });

  it("replacing a number re-opens the form with discovery off, whatever the previous save opted into", async () => {
    render(<DiscoveryPanel initialPhoneLast2="23" initialPhoneDiscoverable={true} />);

    await userEvent.click(screen.getByRole("button", { name: "Replace number" }));

    expect(await screen.findByLabelText("Phone number")).toBeInTheDocument();
    expect(optInSwitch()).toHaveAttribute("aria-checked", "false");
  });
});

describe("DiscoveryPanel save error branches", () => {
  it.each([
    [400, undefined, /doesn't look like a phone number/i],
    [409, "phone_taken", /already linked to another account/i],
    [409, "social_disabled", /turn social back on first/i],
    [429, "rate_limited", /too many attempts/i],
  ] as const)("surfaces the %s/%s copy", async (status, error, copy) => {
    mockFetchOnce({ ok: false, status, body: error ? { error } : {} });
    render(<DiscoveryPanel initialPhoneLast2={null} initialPhoneDiscoverable={false} />);

    await submitPhone();

    expect(await screen.findByRole("alert")).toHaveTextContent(copy);
    // The form stays available for another go.
    expect(screen.getByLabelText("Phone number")).toBeInTheDocument();
  });
});
