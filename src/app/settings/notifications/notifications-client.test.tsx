// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NotificationSettingsView } from "@/lib/notifications/view";
import { NotificationsClient } from "./notifications-client";

// The browser push APIs are not in jsdom, and the point of these tests is the
// screen's behaviour around them rather than the Push API itself.
const webPush = vi.hoisted(() => ({
  webPushSupport: vi.fn(() => ({ supported: true }) as { supported: boolean; reason?: string }),
  webPushPermission: vi.fn(() => "prompt" as string),
  currentSubscriptionEndpoint: vi.fn(async () => null as string | null),
  subscribeToWebPush: vi.fn(async () => ({ ok: true, endpoint: "https://push.example.com/a" })),
  unsubscribeFromWebPush: vi.fn(async () => true),
}));
vi.mock("@/lib/web-push", () => webPush);

afterEach(cleanup);

function view(overrides: Partial<NotificationSettingsView> = {}): NotificationSettingsView {
  return {
    health: { severity: "ok", headline: "Notifications are working", detail: "1 of 1 device is set to receive them.", issues: [] },
    config: { web: { configured: true, missing: [] }, native: { configured: true, missing: [] } },
    account: {
      categories: [
        { id: "price_alert", label: "Wishlist price alerts", description: "A bottle drops.", critical: false, enabled: true, source: "default" },
        { id: "account", label: "Account & security", description: "New sign-ins.", critical: true, enabled: true, source: "default" },
      ],
      quietHours: { enabled: false, start: "22:00", end: "08:00", timeZone: "UTC", description: "10 PM – 8 AM" },
    },
    devices: [],
    deliveries: [],
    vapidPublicKey: "public-key",
    ...overrides,
  };
}

describe("NotificationsClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    webPush.webPushSupport.mockReturnValue({ supported: true });
    webPush.webPushPermission.mockReturnValue("prompt");
    webPush.currentSubscriptionEndpoint.mockResolvedValue(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(view()), { status: 200, headers: { "content-type": "application/json" } })),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it("opens with the health verdict, not with the toggles", () => {
    render(<NotificationsClient initial={view()} />);
    const banner = screen.getByRole("region", { name: "Notification status" });
    expect(banner).toHaveTextContent("Notifications are working");
  });

  it("lists each broken device with its fix, and links to its card", async () => {
    render(
      <NotificationsClient
        initial={view({
          health: {
            severity: "error",
            headline: "One device isn't receiving notifications",
            detail: "Push failed on the devices below.",
            issues: [
              {
                deviceId: "device-1",
                label: "Laptop — Disconnected",
                detail: "The push service rejected this registration.",
                fix: "Turn notifications on again on that device.",
              },
            ],
          },
        })}
      />,
    );

    expect(screen.getByText(/One device isn't receiving/)).toBeInTheDocument();
    expect(screen.getByText(/Turn notifications on again/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Laptop — Disconnected" })).toBeInTheDocument();
  });

  it("saves an account category toggle", async () => {
    render(<NotificationsClient initial={view()} />);
    await userEvent.click(screen.getByRole("switch", { name: "Wishlist price alerts" }));

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/notifications/settings");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ categories: { price_alert: false } });
  });

  it("locks critical categories on and says why", () => {
    render(<NotificationsClient initial={view()} />);
    expect(screen.getByRole("switch", { name: "Account & security" })).toBeDisabled();
    expect(screen.getByText("Always on")).toBeInTheDocument();
  });

  it("hides the account quiet-hours fields while quiet hours are off", () => {
    render(<NotificationsClient initial={view()} />);
    expect(screen.queryByLabelText("Start")).not.toBeInTheDocument();
  });

  it("shows the account quiet-hours fields once they are on", () => {
    render(
      <NotificationsClient
        initial={view({
          account: {
            ...view().account,
            quietHours: { enabled: true, start: "23:00", end: "07:00", timeZone: "UTC", description: "11 PM – 7 AM" },
          },
        })}
      />,
    );
    expect(screen.getByLabelText("Start")).toHaveValue("23:00");
    expect(screen.getByLabelText("End")).toHaveValue("07:00");
  });

  it("offers to turn push on in this browser when it isn't set up", async () => {
    render(<NotificationsClient initial={view()} />);
    // The browser is inspected after mount, so the card resolves asynchronously
    // — rendering an answer during the first pass would be a hydration mismatch.
    await userEvent.click(await screen.findByRole("button", { name: "Turn on" }));
    expect(webPush.subscribeToWebPush).toHaveBeenCalledWith("public-key");
  });

  it("commits to nothing about this browser until it has looked", () => {
    render(<NotificationsClient initial={view()} />);
    expect(screen.getByText(/Checking this browser/i)).toBeInTheDocument();
  });

  it("surfaces the browser's reason when subscribing fails", async () => {
    webPush.subscribeToWebPush.mockResolvedValueOnce({
      ok: false,
      reason: "Notifications are blocked for this site.",
    } as never);
    render(<NotificationsClient initial={view()} />);

    await userEvent.click(await screen.findByRole("button", { name: "Turn on" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Notifications are blocked for this site.");
  });

  it("explains a blocked permission instead of offering a button that cannot work", async () => {
    webPush.webPushPermission.mockReturnValue("denied");
    render(<NotificationsClient initial={view()} />);

    // The permission is read from the browser after mount, not during render.
    await waitFor(() => expect(screen.getByRole("button", { name: "Turn on" })).toBeDisabled());
    expect(screen.getByText(/blocked from sending notifications/i)).toBeInTheDocument();
  });

  it("says so when the server has no web push key at all", async () => {
    render(<NotificationsClient initial={view({ vapidPublicKey: null })} />);
    expect(await screen.findByText(/no web push key configured/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Turn on" })).toBeDisabled();
  });

  it("explains itself in the native app rather than offering browser push", async () => {
    webPush.webPushSupport.mockReturnValue({
      supported: false,
      reason: "The Whaikey app uses system notifications instead of browser push.",
    });
    render(<NotificationsClient initial={view()} />);
    expect(await screen.findByText(/uses system notifications/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Turn on" })).not.toBeInTheDocument();
  });

  it("shows an empty state with a way out when no devices are registered", () => {
    render(<NotificationsClient initial={view()} />);
    expect(screen.getByText("No devices yet")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Your devices (0)" })).toBeInTheDocument();
  });

  it("shows suppressions in the activity log, not just failures", () => {
    render(
      <NotificationsClient
        initial={view({
          deliveries: [
            {
              id: "d1",
              deviceLabel: "Nightstand phone",
              platform: "ios",
              category: "price_alert",
              categoryLabel: "Wishlist price alerts",
              title: "Price drop",
              status: "suppressed_quiet_hours",
              statusLabel: "Held — quiet hours",
              tone: "warn",
              detail: "Quiet hours (10 PM – 8 AM, set on this device)",
              createdAt: "2026-08-09T02:00:00.000Z",
              createdAtLabel: "3h ago",
            },
          ],
        })}
      />,
    );

    expect(screen.getByText("Held — quiet hours")).toBeInTheDocument();
    expect(screen.getByText(/set on this device/)).toBeInTheDocument();
    expect(screen.getByText("3h ago")).toBeInTheDocument();
  });

  it("reports a failed save without losing what is on screen", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "Invalid input", details: ["quietStart: must be HH:MM"] }), { status: 400 })),
    );
    render(<NotificationsClient initial={view()} />);

    await userEvent.click(screen.getByRole("switch", { name: "Wishlist price alerts" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("quietStart: must be HH:MM");
    expect(screen.getByRole("switch", { name: "Wishlist price alerts" })).toBeChecked();
  });
});
