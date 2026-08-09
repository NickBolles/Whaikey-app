/**
 * Turning device state into "is anything wrong, and what do I do about it".
 *
 * The hard part of push is not sending — it is that failure is invisible from
 * the user's side. A revoked subscription, an unconfigured server key, a phone
 * that was muted six weeks ago and an account with every category switched off
 * all present identically: silence. This module names the specific cause and
 * pairs it with the one action that fixes it, so the settings screen can lead
 * with an answer instead of a wall of toggles.
 *
 * Ordering matters. Each device gets the *most actionable* problem it has, not
 * a list — a revoked registration makes its quiet-hours setting irrelevant, and
 * showing both invites the user to fix the wrong one.
 */
import type { PushDevice } from "@/db/schema";
import { NOTIFICATION_CATEGORIES } from "./categories";
import type { PushConfigStatus } from "./config";
import { resolveCategories, resolveQuietHours, type AccountPreferences } from "./settings";

export type HealthSeverity = "ok" | "info" | "warn" | "error";

export type DeviceHealthStatus =
  | "healthy"
  | "quiet"
  | "muted"
  | "silenced"
  | "revoked"
  | "failing"
  | "not_configured"
  | "untested"
  | "stale";

export interface DeviceHealth {
  status: DeviceHealthStatus;
  severity: HealthSeverity;
  /** Two or three words for the status chip. */
  headline: string;
  /** One sentence explaining the state in the user's terms. */
  detail: string;
  /** The single next step, when there is one. */
  fix?: string;
}

/** A device that has not checked in for this long has probably been replaced. */
const STALE_AFTER_DAYS = 60;
/** Two consecutive failures is noise; three is a pattern worth surfacing. */
const FAILING_THRESHOLD = 3;

function daysSince(from: Date, now: Date): number {
  return (now.getTime() - from.getTime()) / 86_400_000;
}

export function deviceHealth(
  device: PushDevice,
  account: AccountPreferences,
  config: PushConfigStatus,
  now: Date = new Date(),
): DeviceHealth {
  const transport = device.platform === "web" ? config.web : config.native;

  if (!transport.configured) {
    return {
      status: "not_configured",
      severity: "error",
      headline: "Server not configured",
      detail:
        device.platform === "web"
          ? "This server has no web push keys, so browser notifications cannot be sent."
          : "This server has no Firebase credentials, so app notifications cannot be sent.",
      fix: `Set ${transport.missing.join(", ")} and redeploy.`,
    };
  }

  if (device.revokedAt) {
    return {
      status: "revoked",
      severity: "error",
      headline: "Disconnected",
      detail:
        device.lastFailureReason ??
        "The push service rejected this registration — it was most likely revoked in browser or system settings.",
      fix: "Open Whaikey on that device and turn notifications on again.",
    };
  }

  if (device.consecutiveFailures >= FAILING_THRESHOLD) {
    return {
      status: "failing",
      severity: "error",
      headline: "Not delivering",
      detail: `${device.consecutiveFailures} sends in a row failed${
        device.lastFailureReason ? `: ${device.lastFailureReason}` : ""
      }.`,
      fix: "Send a test below. If it fails too, re-enable notifications on that device.",
    };
  }

  if (!device.enabled) {
    return {
      status: "muted",
      severity: "info",
      headline: "Muted",
      detail: "You turned this device off, so nothing is sent to it.",
      fix: "Turn it back on to start receiving here again.",
    };
  }

  // Every category off is a silence the user built themselves — but it is still
  // silence, and it is easy to arrive at one toggle at a time without noticing.
  const resolved = resolveCategories(account, device);
  if (resolved.every((c) => !c.enabled)) {
    return {
      status: "silenced",
      severity: "warn",
      headline: "Nothing enabled",
      detail: "Every notification type is switched off for this device, so it will stay silent.",
      fix: "Turn on at least one type below.",
    };
  }

  if (device.consecutiveFailures > 0) {
    return {
      status: "failing",
      severity: "warn",
      headline: "Recent failure",
      detail: `The last send failed${
        device.lastFailureReason ? `: ${device.lastFailureReason}` : ""
      }. Earlier sends worked.`,
      fix: "Send a test to check whether it has recovered.",
    };
  }

  const quiet = resolveQuietHours(account, device, now);
  if (quiet.activeNow && quiet.description) {
    return {
      status: "quiet",
      severity: "ok",
      headline: "Quiet hours",
      detail: `Holding notifications until ${
        quiet.until
          ? quiet.until.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
          : quiet.description.split("–")[1]?.trim()
      } (${quiet.source === "device" ? "this device" : "account default"}).`,
    };
  }

  const lastActivity = device.lastSuccessAt ?? device.lastSeenAt ?? device.createdAt;
  if (daysSince(lastActivity, now) > STALE_AFTER_DAYS) {
    return {
      status: "stale",
      severity: "warn",
      headline: "Inactive",
      detail: `No activity from this device in over ${STALE_AFTER_DAYS} days.`,
      fix: "Remove it if you no longer use it.",
    };
  }

  if (!device.lastSuccessAt) {
    return {
      status: "untested",
      severity: "info",
      headline: "Not verified",
      detail: "This device is registered, but nothing has been delivered to it yet.",
      fix: "Send a test to confirm it works.",
    };
  }

  return {
    status: "healthy",
    severity: "ok",
    headline: "Delivering",
    detail: `Last delivered ${device.lastSuccessAt.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    })}.`,
  };
}

export interface AccountHealth {
  severity: HealthSeverity;
  headline: string;
  detail: string;
  /** Concrete problems, worst first. Empty when everything is fine. */
  issues: Array<{ deviceId?: string; label: string; detail: string; fix?: string }>;
}

const SEVERITY_RANK: Record<HealthSeverity, number> = { ok: 0, info: 1, warn: 2, error: 3 };

/**
 * The banner at the top of the settings screen: one sentence answering "are my
 * notifications working", with the failures behind it listed underneath.
 */
export function accountHealth(
  devices: PushDevice[],
  account: AccountPreferences,
  config: PushConfigStatus,
  now: Date = new Date(),
): AccountHealth {
  if (devices.length === 0) {
    return {
      severity: "warn",
      headline: "No devices are set up",
      detail:
        "Notifications need at least one device. Turn them on in this browser, or open the Whaikey app on your phone.",
      issues: [],
    };
  }

  const perDevice = devices.map((device) => ({
    device,
    health: deviceHealth(device, account, config, now),
  }));

  const issues: AccountHealth["issues"] = perDevice
    .filter(({ health }) => health.severity === "error" || health.severity === "warn")
    .sort((a, b) => SEVERITY_RANK[b.health.severity] - SEVERITY_RANK[a.health.severity])
    .map(({ device, health }) => ({
      deviceId: device.id,
      label: `${deviceName(device)} — ${health.headline}`,
      detail: health.detail,
      fix: health.fix,
    }));

  // An account with every category off is a whole-account silence, and no
  // single device is at fault, so it is reported here rather than per device.
  const accountSilenced = NOTIFICATION_CATEGORIES.every(
    (c) => account.categories[c.id] === false || (!c.defaultEnabled && account.categories[c.id] !== true),
  );
  if (accountSilenced) {
    issues.unshift({
      deviceId: undefined,
      label: "Every notification type is off",
      detail: "Nothing will be sent to any device while all account types are switched off.",
      fix: "Turn on at least one type under Account defaults.",
    });
  }

  const errorCount = perDevice.filter(({ health }) => health.severity === "error").length;
  if (errorCount > 0) {
    return {
      severity: "error",
      headline:
        errorCount === 1
          ? "One device isn't receiving notifications"
          : `${errorCount} devices aren't receiving notifications`,
      detail: "Push failed on the devices below. Each one lists what to do about it.",
      issues,
    };
  }

  if (issues.length > 0) {
    return {
      severity: "warn",
      headline: "Some notifications won't arrive",
      detail: "Nothing is broken, but these settings will keep some devices silent.",
      issues,
    };
  }

  const delivering = perDevice.filter(({ health }) => health.status !== "muted").length;
  return {
    severity: "ok",
    headline: "Notifications are working",
    detail: `${delivering} of ${devices.length} device${devices.length === 1 ? "" : "s"} ${
      delivering === 1 ? "is" : "are"
    } set to receive them.`,
    issues: [],
  };
}

/** Display name for a device: the label if set, else a platform-shaped guess. */
export function deviceName(device: Pick<PushDevice, "label" | "platform" | "userAgent">): string {
  if (device.label && device.label.trim().length > 0) return device.label.trim();
  const fromAgent = describeUserAgent(device.userAgent);
  if (fromAgent) return fromAgent;
  return device.platform === "ios" ? "iPhone" : device.platform === "android" ? "Android phone" : "Browser";
}

/**
 * A short, honest name from a UA string — "Chrome on macOS", not a version
 * soup. Only used when the user has not named the device themselves.
 */
export function describeUserAgent(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /OPR\//.test(userAgent)
      ? "Opera"
      : /Firefox\//.test(userAgent)
        ? "Firefox"
        : /Chrome\//.test(userAgent)
          ? "Chrome"
          : /Safari\//.test(userAgent)
            ? "Safari"
            : null;
  const os = /iPhone|iPad/.test(userAgent)
    ? "iOS"
    : /Android/.test(userAgent)
      ? "Android"
      : /Mac OS X/.test(userAgent)
        ? "macOS"
        : /Windows/.test(userAgent)
          ? "Windows"
          : /Linux/.test(userAgent)
            ? "Linux"
            : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os;
}
