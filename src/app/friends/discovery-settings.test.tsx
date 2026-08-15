// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DiscoverySettings } from "@/app/friends/discovery-settings";

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

async function openDisclosure() {
  await userEvent.click(screen.getByRole("button", { name: /discovery settings/i }));
}

describe("DiscoverySettings disclosure", () => {
  it("is collapsed by default and expands to the phone settings + privacy link", async () => {
    render(<DiscoverySettings initialPhoneLast2={null} initialPhoneDiscoverable={false} />);

    const toggle = screen.getByRole("button", { name: /discovery settings/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("Phone number")).not.toBeInTheDocument();

    await openDisclosure();

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Phone number")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /privacy & sharing/i })).toHaveAttribute("href", "/sharing");
  });
});

describe("DiscoverySettings phone opt-in (docs/SOCIAL.md D8 as amended)", () => {
  it("never preselects discovery on the add form", async () => {
    render(<DiscoverySettings initialPhoneLast2={null} initialPhoneDiscoverable={false} />);
    await openDisclosure();
    expect(optInSwitch()).toHaveAttribute("aria-checked", "false");
  });

  it("removing a discoverable number resets the add form's opt-in to off", async () => {
    mockFetchOnce({ ok: true, body: { removed: true } });
    render(<DiscoverySettings initialPhoneLast2="23" initialPhoneDiscoverable={true} />);
    await openDisclosure();

    await userEvent.click(screen.getByRole("button", { name: "Remove" }));

    // The add form is back — and a replacement save must require a fresh
    // opt-in, not inherit the removed number's discoverability.
    expect(await screen.findByLabelText("Phone number")).toBeInTheDocument();
    expect(optInSwitch()).toHaveAttribute("aria-checked", "false");
  });

  it("replacing a number re-opens the form with discovery off, whatever the previous save opted into", async () => {
    render(<DiscoverySettings initialPhoneLast2="23" initialPhoneDiscoverable={true} />);
    await openDisclosure();

    await userEvent.click(screen.getByRole("button", { name: "Replace number" }));

    expect(await screen.findByLabelText("Phone number")).toBeInTheDocument();
    expect(optInSwitch()).toHaveAttribute("aria-checked", "false");
  });
});
