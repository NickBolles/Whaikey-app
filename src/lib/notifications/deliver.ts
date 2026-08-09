/**
 * Sending a notification: fan out across a user's devices, apply each device's
 * own settings, record what happened either way.
 *
 * The recording is the point. Push is fire-and-forget by nature, so without a
 * durable trail "it didn't arrive" is unanswerable — nobody can tell a dead
 * subscription from a quiet-hours hold from a category the user switched off
 * last month. Every attempt writes a row, suppressions included, and the
 * settings screen reads those rows back as plain sentences.
 */
import { and, desc, eq } from "drizzle-orm";
import type { DB } from "@/db";
import { schema } from "@/db";
import type { DeliveryStatus, NotificationDelivery, PushDevice } from "@/db/schema";
import { getPushConfigStatus } from "./config";
import { deviceName } from "./health";
import { getPushSender, type PushMessage } from "./sender";
import { loadAccountPreferences, routeToDevice, type AccountPreferences } from "./settings";

export interface DeviceOutcome {
  deviceId: string;
  deviceLabel: string;
  status: DeliveryStatus;
  detail: string | null;
}

export interface DeliveryReport {
  /** How many devices actually received the notification. */
  delivered: number;
  /** Devices skipped by settings — not errors. */
  suppressed: number;
  failed: number;
  outcomes: DeviceOutcome[];
}

export interface SendOptions {
  /** Restrict to one device — used by the "send test" button. */
  deviceId?: string;
  /** Injectable clock so quiet-hours behaviour is testable. */
  now?: Date;
  /** Preloaded prefs, to avoid a second read when the caller already has them. */
  account?: AccountPreferences;
}

/**
 * Deliver `message` to every device that should get it.
 *
 * Never throws for delivery reasons: a push service being down must not fail
 * the price-check job or the request that triggered it. Failures land in the
 * report and in the log.
 */
export async function sendNotification(
  db: DB,
  userId: string,
  message: PushMessage,
  options: SendOptions = {},
): Promise<DeliveryReport> {
  const now = options.now ?? new Date();
  const account = options.account ?? (await loadAccountPreferences(db, userId));
  const config = getPushConfigStatus();
  const sender = getPushSender();

  const devices = await db
    .select()
    .from(schema.pushDevices)
    .where(
      options.deviceId
        ? and(eq(schema.pushDevices.userId, userId), eq(schema.pushDevices.id, options.deviceId))
        : eq(schema.pushDevices.userId, userId),
    );

  if (devices.length === 0) {
    await recordDelivery(db, userId, null, message, "no_devices", "No devices are registered");
    return { delivered: 0, suppressed: 0, failed: 0, outcomes: [] };
  }

  const outcomes: DeviceOutcome[] = [];

  for (const device of devices) {
    const transport = device.platform === "web" ? config.web : config.native;
    if (!transport.configured) {
      outcomes.push(
        await settle(db, userId, device, message, "not_configured", `Missing ${transport.missing.join(", ")}`),
      );
      continue;
    }

    const decision = routeToDevice(account, device, message.category, now);
    if (!decision.deliver) {
      outcomes.push(await settle(db, userId, device, message, decision.status, decision.detail));
      continue;
    }

    const result = await sender.send(device, message);
    if (result.ok) {
      await db
        .update(schema.pushDevices)
        .set({ lastSuccessAt: now, consecutiveFailures: 0, lastFailureReason: null, updatedAt: now })
        .where(eq(schema.pushDevices.id, device.id));
      outcomes.push(await settle(db, userId, device, message, "delivered", null));
      continue;
    }

    // A `gone` registration is retired rather than retried: the push service has
    // told us it will never work again, and leaving it listed as healthy is how
    // users end up believing notifications work when they don't.
    await db
      .update(schema.pushDevices)
      .set({
        lastFailureAt: now,
        lastFailureReason: result.error ?? "Delivery failed",
        consecutiveFailures: device.consecutiveFailures + 1,
        revokedAt: result.gone ? now : device.revokedAt,
        updatedAt: now,
      })
      .where(eq(schema.pushDevices.id, device.id));

    outcomes.push(
      await settle(
        db,
        userId,
        device,
        message,
        result.notConfigured ? "not_configured" : "failed",
        result.error ?? "Delivery failed",
      ),
    );
  }

  return {
    delivered: outcomes.filter((o) => o.status === "delivered").length,
    suppressed: outcomes.filter((o) => o.status.startsWith("suppressed")).length,
    failed: outcomes.filter((o) => o.status === "failed" || o.status === "not_configured").length,
    outcomes,
  };
}

async function settle(
  db: DB,
  userId: string,
  device: PushDevice,
  message: PushMessage,
  status: DeliveryStatus,
  detail: string | null,
): Promise<DeviceOutcome> {
  await recordDelivery(db, userId, device, message, status, detail);
  return { deviceId: device.id, deviceLabel: deviceName(device), status, detail };
}

async function recordDelivery(
  db: DB,
  userId: string,
  device: PushDevice | null,
  message: PushMessage,
  status: DeliveryStatus,
  detail: string | null,
): Promise<void> {
  await db.insert(schema.notificationDeliveries).values({
    id: crypto.randomUUID(),
    userId,
    deviceId: device?.id ?? null,
    deviceLabel: device ? deviceName(device) : null,
    devicePlatform: device?.platform ?? null,
    category: message.category,
    title: message.title,
    status,
    detail,
  });
}

/** Most recent attempts, newest first — the settings screen's activity list. */
export async function listRecentDeliveries(
  db: DB,
  userId: string,
  limit = 20,
): Promise<NotificationDelivery[]> {
  return db
    .select()
    .from(schema.notificationDeliveries)
    .where(eq(schema.notificationDeliveries.userId, userId))
    .orderBy(desc(schema.notificationDeliveries.createdAt))
    .limit(limit);
}

/** One line per status, written for the person reading their own log. */
export function describeDeliveryStatus(status: DeliveryStatus): { label: string; tone: "ok" | "warn" | "error" } {
  switch (status) {
    case "delivered":
      return { label: "Delivered", tone: "ok" };
    case "failed":
      return { label: "Failed", tone: "error" };
    case "not_configured":
      return { label: "Server not configured", tone: "error" };
    case "suppressed_quiet_hours":
      return { label: "Held — quiet hours", tone: "warn" };
    case "suppressed_category":
      return { label: "Skipped — type is off", tone: "warn" };
    case "suppressed_device":
      return { label: "Skipped — device is off", tone: "warn" };
    case "no_devices":
      return { label: "No devices", tone: "warn" };
  }
}
