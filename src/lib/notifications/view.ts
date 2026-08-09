/**
 * The one payload the settings screen renders.
 *
 * The page (a server component) and `GET /api/notifications/settings` both
 * build it here, so a value the user sees after a save is produced by exactly
 * the same code as the value they saw on load. Everything is already
 * JSON-serialisable — dates as ISO strings, health already resolved to
 * sentences — because the alternative is a client component re-deriving
 * "is this broken" from raw columns, which is how two screens end up
 * disagreeing about whether push works.
 */
import type { DB } from "@/db";
import type { DevicePlatform, PushDevice, QuietHoursMode } from "@/db/schema";
import { getCategory, NOTIFICATION_CATEGORIES } from "./categories";
import { getPushConfigStatus, getVapidConfig, type PushConfigStatus } from "./config";
import { describeDeliveryStatus, listRecentDeliveries } from "./deliver";
import { accountHealth, deviceHealth, deviceName, type AccountHealth, type DeviceHealth } from "./health";
import { describeQuietWindow } from "./quiet-hours";
import {
  listDevices,
  loadAccountPreferences,
  resolveCategory,
  resolveQuietHours,
  type AccountPreferences,
  type SettingSource,
} from "./settings";

export interface CategoryView {
  id: string;
  label: string;
  description: string;
  critical: boolean;
  enabled: boolean;
  source: SettingSource;
}

export interface QuietHoursView {
  mode: QuietHoursMode;
  start: string | null;
  end: string | null;
  timeZone: string | null;
  /** What is actually in force, after inheritance. */
  effective: {
    description: string | null;
    source: SettingSource;
    activeNow: boolean;
    until: string | null;
  };
}

export interface DeviceView {
  id: string;
  name: string;
  platform: DevicePlatform;
  enabled: boolean;
  /** Matched against the browser's own subscription endpoint, client-side. */
  token: string;
  health: DeviceHealth;
  quietHours: QuietHoursView;
  categories: CategoryView[];
  lastSeenAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
  createdAt: string;
}

export interface DeliveryView {
  id: string;
  deviceLabel: string | null;
  platform: DevicePlatform | null;
  category: string;
  categoryLabel: string;
  title: string;
  status: string;
  statusLabel: string;
  tone: "ok" | "warn" | "error";
  detail: string | null;
  createdAt: string;
  /**
   * "12m ago", formatted here rather than in the browser.
   *
   * A client-side clock would disagree with the server-rendered HTML on the
   * first paint (and reading one during render is impure besides). The value
   * goes stale as the page sits, which is fine: every mutation replaces the
   * whole view, so the log re-dates itself whenever anything happens.
   */
  createdAtLabel: string;
}

export interface AccountQuietHoursView {
  enabled: boolean;
  start: string;
  end: string;
  timeZone: string;
  description: string;
}

export interface NotificationSettingsView {
  health: AccountHealth;
  config: PushConfigStatus;
  account: {
    categories: CategoryView[];
    quietHours: AccountQuietHoursView;
  };
  devices: DeviceView[];
  deliveries: DeliveryView[];
  /** Needed in the browser to build a push subscription; null when unconfigured. */
  vapidPublicKey: string | null;
}

function accountCategoryViews(account: AccountPreferences): CategoryView[] {
  return NOTIFICATION_CATEGORIES.map((category) => {
    const resolved = resolveCategory(account, null, category.id);
    return {
      id: category.id,
      label: category.label,
      description: category.description,
      critical: category.critical ?? false,
      enabled: resolved.enabled,
      source: resolved.source,
    };
  });
}

function deviceCategoryViews(account: AccountPreferences, device: PushDevice): CategoryView[] {
  return NOTIFICATION_CATEGORIES.map((category) => {
    const resolved = resolveCategory(account, device, category.id);
    return {
      id: category.id,
      label: category.label,
      description: category.description,
      critical: category.critical ?? false,
      enabled: resolved.enabled,
      source: resolved.source,
    };
  });
}

export function toDeviceView(
  device: PushDevice,
  account: AccountPreferences,
  config: PushConfigStatus,
  now: Date,
): DeviceView {
  const effective = resolveQuietHours(account, device, now);
  return {
    id: device.id,
    name: deviceName(device),
    platform: device.platform,
    enabled: device.enabled,
    token: device.token,
    health: deviceHealth(device, account, config, now),
    quietHours: {
      mode: device.quietHoursMode,
      start: device.quietStart,
      end: device.quietEnd,
      timeZone: device.timeZone,
      effective: {
        description: effective.description,
        source: effective.source,
        activeNow: effective.activeNow,
        until: effective.until?.toISOString() ?? null,
      },
    },
    categories: deviceCategoryViews(account, device),
    lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
    lastSuccessAt: device.lastSuccessAt?.toISOString() ?? null,
    lastFailureAt: device.lastFailureAt?.toISOString() ?? null,
    lastFailureReason: device.lastFailureReason,
    createdAt: device.createdAt.toISOString(),
  };
}

/** Short, scannable age of an event: "just now", "12m ago", "3h ago", "Aug 9". */
export function relativeLabel(at: Date, now: Date): string {
  const minutes = Math.round((now.getTime() - at.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  return at.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export async function buildSettingsView(
  db: DB,
  userId: string,
  now: Date = new Date(),
): Promise<NotificationSettingsView> {
  const config = getPushConfigStatus();
  const [account, devices, deliveries] = await Promise.all([
    loadAccountPreferences(db, userId),
    listDevices(db, userId),
    listRecentDeliveries(db, userId, 20),
  ]);

  return {
    health: accountHealth(devices, account, config, now),
    config,
    account: {
      categories: accountCategoryViews(account),
      quietHours: {
        enabled: account.quietHoursEnabled,
        start: account.quietStart,
        end: account.quietEnd,
        timeZone: account.timeZone,
        description: describeQuietWindow({ start: account.quietStart, end: account.quietEnd }),
      },
    },
    devices: devices.map((device) => toDeviceView(device, account, config, now)),
    deliveries: deliveries.map((row) => {
      const described = describeDeliveryStatus(row.status);
      return {
        id: row.id,
        deviceLabel: row.deviceLabel,
        platform: row.devicePlatform,
        category: row.category,
        categoryLabel: getCategory(row.category)?.label ?? "Test notification",
        title: row.title,
        status: row.status,
        statusLabel: described.label,
        tone: described.tone,
        detail: row.detail,
        createdAt: row.createdAt.toISOString(),
        createdAtLabel: relativeLabel(row.createdAt, now),
      };
    }),
    vapidPublicKey: getVapidConfig()?.publicKey ?? null,
  };
}
