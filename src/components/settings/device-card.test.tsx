// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DeviceCard } from "@/components/settings/device-card";
import type { AccountQuietHoursView, DeviceView } from "@/lib/notifications/view";

afterEach(cleanup);

const ACCOUNT_QUIET: AccountQuietHoursView = {
  enabled: true,
  start: "22:00",
  end: "08:00",
  timeZone: "UTC",
  description: "10 PM – 8 AM",
};

function deviceView(overrides: Partial<DeviceView> = {}): DeviceView {
  return {
    id: "device-1",
    name: "Nightstand phone",
    platform: "ios",
    enabled: true,
    token: "token-1",
    health: { status: "healthy", severity: "ok", headline: "Delivering", detail: "Last delivered Aug 8." },
    quietHours: {
      mode: "inherit",
      start: null,
      end: null,
      timeZone: null,
      effective: { description: "10 PM – 8 AM", source: "account", activeNow: false, until: null },
    },
    categories: [
      { id: "price_alert", label: "Wishlist price alerts", description: "", critical: false, enabled: true, source: "default" },
      { id: "account", label: "Account & security", description: "", critical: true, enabled: true, source: "default" },
    ],
    lastSeenAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureReason: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function renderCard(overrides: Partial<DeviceView> = {}, props: Partial<Parameters<typeof DeviceCard>[0]> = {}) {
  const onPatch = vi.fn();
  const onTest = vi.fn();
  const onRemove = vi.fn();
  render(
    <DeviceCard
      device={deviceView(overrides)}
      isCurrent={false}
      accountQuietHours={ACCOUNT_QUIET}
      busy={false}
      testResult={null}
      onPatch={onPatch}
      onTest={onTest}
      onRemove={onRemove}
      {...props}
    />,
  );
  return { onPatch, onTest, onRemove };
}

describe("DeviceCard", () => {
  it("leads with the device's health and its fix", () => {
    renderCard({
      health: {
        status: "revoked",
        severity: "error",
        headline: "Disconnected",
        detail: "The push service rejected this registration.",
        fix: "Open Whaikey on that device and turn notifications on again.",
      },
    });

    expect(screen.getByText("Disconnected")).toBeInTheDocument();
    expect(screen.getByText(/push service rejected/i)).toBeInTheDocument();
    expect(screen.getByText(/turn notifications on again/i)).toBeInTheDocument();
  });

  it("mutes the device without touching anything else", async () => {
    const { onPatch } = renderCard();
    await userEvent.click(screen.getByRole("switch", { name: "Receive notifications here" }));
    expect(onPatch).toHaveBeenCalledWith({ enabled: false });
  });

  it("explains the inherited quiet window instead of leaving it blank", () => {
    renderCard();
    expect(screen.getByText(/Following your account setting: 10 PM – 8 AM/)).toBeInTheDocument();
  });

  it("seeds a custom window from the account default so the first click is valid", async () => {
    // An empty form here would be a 400 waiting to happen.
    const { onPatch } = renderCard();
    await userEvent.click(screen.getByRole("radio", { name: "Custom" }));
    expect(onPatch).toHaveBeenCalledWith(
      expect.objectContaining({ quietHoursMode: "custom", quietStart: "22:00", quietEnd: "08:00" }),
    );
  });

  it("shows the editable window once the device has its own", () => {
    renderCard({
      quietHours: {
        mode: "custom",
        start: "21:00",
        end: "06:30",
        timeZone: "Europe/Lisbon",
        effective: { description: "9 PM – 6:30 AM", source: "device", activeNow: true, until: null },
      },
    });

    expect(screen.getByLabelText("Start")).toHaveValue("21:00");
    expect(screen.getByLabelText("End")).toHaveValue("06:30");
    expect(screen.getByText("Holding now")).toBeInTheDocument();
  });

  it("says a device is opted out of quiet hours entirely", () => {
    renderCard({
      quietHours: {
        mode: "off",
        start: null,
        end: null,
        timeZone: null,
        effective: { description: null, source: "device", activeNow: false, until: null },
      },
    });
    expect(screen.getByText(/reach this device at any hour/i)).toBeInTheDocument();
  });

  it("keeps the per-device types collapsed while they match the account", async () => {
    // Five identical switches per device is what made the old screen a wall.
    renderCard();
    expect(screen.queryByRole("switch", { name: "Wishlist price alerts" })).not.toBeInTheDocument();
    expect(screen.getByText("Following your account defaults")).toBeInTheDocument();
  });

  it("overrides one category for this device only", async () => {
    const { onPatch } = renderCard();
    await userEvent.click(screen.getByRole("button", { name: /types on this device/i }));
    await userEvent.click(screen.getByRole("switch", { name: "Wishlist price alerts" }));
    expect(onPatch).toHaveBeenCalledWith({ categoryOverrides: { price_alert: false } });
  });

  it("opens already showing the exceptions when a device has some", () => {
    // An override hidden behind a chevron is an override nobody finds again.
    renderCard({
      categories: [
        { id: "price_alert", label: "Wishlist price alerts", description: "", critical: false, enabled: false, source: "device" },
      ],
    });
    expect(screen.getByRole("switch", { name: "Wishlist price alerts" })).toBeInTheDocument();
    expect(screen.getByText("1 changed for this device")).toBeInTheDocument();
  });

  it("offers a reset that clears the override rather than setting it false", async () => {
    const { onPatch } = renderCard({
      categories: [
        { id: "price_alert", label: "Wishlist price alerts", description: "", critical: false, enabled: false, source: "device" },
      ],
    });

    await userEvent.click(screen.getByRole("button", { name: /reset to account default/i }));
    expect(onPatch).toHaveBeenCalledWith({ categoryOverrides: { price_alert: null } });
  });

  it("only shows the reset action on overridden categories", async () => {
    renderCard();
    await userEvent.click(screen.getByRole("button", { name: /types on this device/i }));
    expect(screen.queryByRole("button", { name: /reset to account default/i })).not.toBeInTheDocument();
  });

  it("renames the device on Enter", async () => {
    const { onPatch } = renderCard();
    await userEvent.click(screen.getByRole("button", { name: "Rename Nightstand phone" }));
    const input = screen.getByLabelText("Device name");
    await userEvent.clear(input);
    await userEvent.type(input, "Kitchen iPad{Enter}");
    expect(onPatch).toHaveBeenCalledWith({ label: "Kitchen iPad" });
  });

  it("abandons a rename on Escape", async () => {
    const { onPatch } = renderCard();
    await userEvent.click(screen.getByRole("button", { name: "Rename Nightstand phone" }));
    await userEvent.type(screen.getByLabelText("Device name"), "something else{Escape}");
    expect(onPatch).not.toHaveBeenCalled();
    expect(screen.getByText("Nightstand phone")).toBeInTheDocument();
  });

  it("requires a confirmation before removing", async () => {
    const { onRemove } = renderCard();
    await userEvent.click(screen.getByRole("button", { name: /^remove$/i }));
    expect(onRemove).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /yes, remove/i }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("sends a test and reports a held one honestly", async () => {
    const { onTest } = renderCard(
      {},
      {
        testResult: {
          deviceId: "device-1",
          deviceLabel: "Nightstand phone",
          status: "suppressed_quiet_hours",
          detail: "Quiet hours (10 PM – 8 AM)",
        },
      },
    );

    await userEvent.click(screen.getByRole("button", { name: /send test/i }));
    expect(onTest).toHaveBeenCalled();

    const status = screen.getByRole("status");
    expect(within(status).getByText(/Not sent — Quiet hours/)).toBeInTheDocument();
  });

  it("marks the browser you are looking at", () => {
    renderCard({}, { isCurrent: true });
    expect(screen.getByText("This device")).toBeInTheDocument();
  });
});
