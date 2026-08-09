/**
 * Account defaults, per-device overrides, and the routing decision that falls
 * out of the two.
 *
 * Settings resolve in three layers — category default → account → device — and
 * every resolved value carries the layer it came from. That `source` tag is not
 * decoration: a toggle the user cannot explain is a toggle they will not trust,
 * and "off, because your account default says so" is a different problem from
 * "off, because you muted this laptop" even though both render as a grey
 * switch.
 */
import { and, desc, eq } from "drizzle-orm";
import type { DB } from "@/db";
import { schema } from "@/db";
import type {
  DeliveryStatus,
  NotificationPreference,
  PushDevice,
  QuietHoursMode,
} from "@/db/schema";
import { defaultCategoryMap, getCategory, TEST_CATEGORY_ID } from "./categories";
import {
  describeQuietWindow,
  isValidTimeOfDay,
  isValidTimeZone,
  isWithinQuietWindow,
  quietWindowEndsAt,
  type QuietWindow,
} from "./quiet-hours";

export type SettingSource = "default" | "account" | "device";

export interface AccountPreferences {
  categories: Record<string, boolean>;
  quietHoursEnabled: boolean;
  quietStart: string;
  quietEnd: string;
  timeZone: string;
}

export const ACCOUNT_DEFAULTS: AccountPreferences = {
  categories: {},
  quietHoursEnabled: false,
  quietStart: "22:00",
  quietEnd: "08:00",
  timeZone: "UTC",
};

/**
 * Read the account row, or the defaults if the user has never saved one.
 *
 * Deliberately does not write: a GET on the settings page must not create rows,
 * or every crawler and health check leaves a trail. The row appears on first
 * save.
 */
export async function loadAccountPreferences(db: DB, userId: string): Promise<AccountPreferences> {
  const [row] = await db
    .select()
    .from(schema.notificationPreferences)
    .where(eq(schema.notificationPreferences.userId, userId))
    .limit(1);
  return row ? fromRow(row) : { ...ACCOUNT_DEFAULTS };
}

function fromRow(row: NotificationPreference): AccountPreferences {
  return {
    categories: row.categories ?? {},
    quietHoursEnabled: row.quietHoursEnabled,
    quietStart: row.quietStart,
    quietEnd: row.quietEnd,
    timeZone: row.timeZone,
  };
}

/** Upsert the account row, merging `patch` over whatever is stored today. */
export async function saveAccountPreferences(
  db: DB,
  userId: string,
  patch: Partial<AccountPreferences>,
): Promise<AccountPreferences> {
  const current = await loadAccountPreferences(db, userId);
  const next: AccountPreferences = {
    ...current,
    ...patch,
    // Category maps merge rather than replace, so a UI that only knows about
    // today's categories cannot wipe a user's answer for one added later.
    categories: { ...current.categories, ...(patch.categories ?? {}) },
  };

  const now = new Date();
  await db
    .insert(schema.notificationPreferences)
    .values({ userId, ...next })
    .onConflictDoUpdate({
      target: schema.notificationPreferences.userId,
      set: { ...next, updatedAt: now },
    });

  return next;
}

export async function listDevices(db: DB, userId: string): Promise<PushDevice[]> {
  return db
    .select()
    .from(schema.pushDevices)
    .where(eq(schema.pushDevices.userId, userId))
    .orderBy(desc(schema.pushDevices.updatedAt));
}

export async function getDevice(db: DB, userId: string, deviceId: string): Promise<PushDevice | null> {
  const [row] = await db
    .select()
    .from(schema.pushDevices)
    .where(and(eq(schema.pushDevices.id, deviceId), eq(schema.pushDevices.userId, userId)))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ResolvedCategory {
  id: string;
  enabled: boolean;
  source: SettingSource;
}

export interface ResolvedQuietHours {
  /** Null when nothing holds notifications on this device. */
  window: QuietWindow | null;
  source: SettingSource;
  /** True when `window` is non-null and the reference instant sits inside it. */
  activeNow: boolean;
  /** When the current hold lifts, if one is active. */
  until: Date | null;
  /** "10 PM – 8 AM", or null when there is no window. */
  description: string | null;
}

/** One category's answer for one device, with the layer that decided it. */
export function resolveCategory(
  account: AccountPreferences,
  device: Pick<PushDevice, "categoryOverrides"> | null,
  categoryId: string,
): ResolvedCategory {
  const deviceValue = device?.categoryOverrides?.[categoryId];
  if (typeof deviceValue === "boolean") {
    return { id: categoryId, enabled: deviceValue, source: "device" };
  }
  const accountValue = account.categories[categoryId];
  if (typeof accountValue === "boolean") {
    return { id: categoryId, enabled: accountValue, source: "account" };
  }
  return {
    id: categoryId,
    enabled: getCategory(categoryId)?.defaultEnabled ?? true,
    source: "default",
  };
}

export function resolveCategories(
  account: AccountPreferences,
  device: Pick<PushDevice, "categoryOverrides"> | null,
): ResolvedCategory[] {
  return Object.keys(defaultCategoryMap()).map((id) => resolveCategory(account, device, id));
}

type QuietDeviceFields = Pick<
  PushDevice,
  "quietHoursMode" | "quietStart" | "quietEnd" | "timeZone"
>;

/**
 * The quiet window in force for a device.
 *
 * `custom` on a device wins outright — including over an account that has quiet
 * hours switched off, which is the "my phone sleeps but my desktop doesn't"
 * case this whole feature exists for. `off` is the mirror image: an explicit
 * opt-out of an account-wide window.
 */
export function resolveQuietHours(
  account: AccountPreferences,
  device: QuietDeviceFields | null,
  now: Date = new Date(),
): ResolvedQuietHours {
  const mode: QuietHoursMode = device?.quietHoursMode ?? "inherit";

  let window: QuietWindow | null = null;
  let source: SettingSource = "default";

  if (device && mode === "custom" && device.quietStart && device.quietEnd) {
    window = {
      start: device.quietStart,
      end: device.quietEnd,
      timeZone: device.timeZone ?? account.timeZone,
    };
    source = "device";
  } else if (device && mode === "off") {
    source = "device";
  } else if (account.quietHoursEnabled) {
    window = { start: account.quietStart, end: account.quietEnd, timeZone: account.timeZone };
    source = "account";
  } else {
    source = "account";
  }

  const activeNow = window ? isWithinQuietWindow(now, window) : false;
  return {
    window,
    source,
    activeNow,
    until: window && activeNow ? quietWindowEndsAt(now, window) : null,
    description: window ? describeQuietWindow(window) : null,
  };
}

export interface RoutingDecision {
  deliver: boolean;
  status: DeliveryStatus;
  /** Human-readable reason, stored on the delivery row and shown in the log. */
  detail: string | null;
}

/**
 * Should this category go to this device, right now?
 *
 * The single place the layers combine. Everything that sends goes through it,
 * and the settings screen calls it too so the preview a user sees is produced
 * by the same code that will decide at 3am.
 */
export function routeToDevice(
  account: AccountPreferences,
  device: PushDevice,
  categoryId: string,
  now: Date = new Date(),
): RoutingDecision {
  if (device.revokedAt) {
    return {
      deliver: false,
      status: "suppressed_device",
      detail: device.lastFailureReason ?? "Push registration is no longer valid",
    };
  }
  if (!device.enabled) {
    return { deliver: false, status: "suppressed_device", detail: "Device is muted" };
  }

  const category = getCategory(categoryId);
  const isTest = categoryId === TEST_CATEGORY_ID;

  if (!isTest) {
    const resolved = resolveCategory(account, device, categoryId);
    if (!resolved.enabled) {
      return {
        deliver: false,
        status: "suppressed_category",
        detail:
          resolved.source === "device"
            ? `Turned off for this device`
            : `Turned off for your account`,
      };
    }
  }

  // Critical categories are exempt from quiet hours; a test send is not, so
  // that "send test" answers the question the user actually asked.
  if (!category?.critical) {
    const quiet = resolveQuietHours(account, device, now);
    if (quiet.activeNow && quiet.window) {
      return {
        deliver: false,
        status: "suppressed_quiet_hours",
        detail: `Quiet hours (${describeQuietWindow(quiet.window)}${
          quiet.source === "device" ? ", set on this device" : ""
        })`,
      };
    }
  }

  return { deliver: true, status: "delivered", detail: null };
}

// ---------------------------------------------------------------------------
// Validation shared by the routes and the UI
// ---------------------------------------------------------------------------

/** Normalize a quiet-hours patch, returning an error string if unusable. */
export function validateQuietWindow(input: {
  start?: string | null;
  end?: string | null;
  timeZone?: string | null;
}): string | null {
  if (input.start != null && !isValidTimeOfDay(input.start)) return "start must be HH:MM";
  if (input.end != null && !isValidTimeOfDay(input.end)) return "end must be HH:MM";
  if (input.timeZone != null && !isValidTimeZone(input.timeZone)) {
    return "timeZone must be a valid IANA zone";
  }
  return null;
}
