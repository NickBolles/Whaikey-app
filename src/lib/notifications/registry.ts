/**
 * Registering, updating and removing devices.
 *
 * Shared by the native token endpoint and the web subscription endpoint so both
 * transports land in one table with one set of rules — most importantly that a
 * re-registration *clears* the revoked flag. A user whose subscription died and
 * who then turns notifications back on has fixed the problem; the settings
 * screen must stop telling them it is broken the moment they do.
 */
import { and, eq } from "drizzle-orm";
import type { DB } from "@/db";
import { schema } from "@/db";
import type { DevicePlatform, PushDevice, QuietHoursMode } from "@/db/schema";
import { describeUserAgent } from "./health";

export interface RegisterDeviceInput {
  /** Native token, or the web push endpoint URL. */
  token: string;
  platform: DevicePlatform;
  p256dh?: string | null;
  authSecret?: string | null;
  userAgent?: string | null;
  label?: string | null;
  /** The device's own zone, so its quiet hours mean what it thinks they mean. */
  timeZone?: string | null;
}

export async function registerDevice(
  db: DB,
  userId: string,
  input: RegisterDeviceInput,
): Promise<PushDevice> {
  const now = new Date();
  const label = input.label?.trim() || describeUserAgent(input.userAgent) || null;

  await db
    .insert(schema.pushDevices)
    .values({
      id: crypto.randomUUID(),
      userId,
      token: input.token,
      platform: input.platform,
      p256dh: input.p256dh ?? null,
      authSecret: input.authSecret ?? null,
      userAgent: input.userAgent ?? null,
      label,
      timeZone: input.timeZone ?? null,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: schema.pushDevices.token,
      set: {
        // A token can move between users on a shared device; reassigning it
        // also stops the previous user's notifications following the hardware.
        userId,
        platform: input.platform,
        p256dh: input.p256dh ?? null,
        authSecret: input.authSecret ?? null,
        userAgent: input.userAgent ?? null,
        lastSeenAt: now,
        // Re-registering is the fix for a dead subscription, so clear the
        // failure state rather than making the user hunt for a reset button.
        revokedAt: null,
        consecutiveFailures: 0,
        lastFailureReason: null,
        updatedAt: now,
      },
    });

  const [row] = await db
    .select()
    .from(schema.pushDevices)
    .where(eq(schema.pushDevices.token, input.token))
    .limit(1);
  return row;
}

export interface DevicePatch {
  label?: string | null;
  enabled?: boolean;
  /**
   * Merged over the stored map. A `null` value *removes* that key, which is how
   * a device goes back to following the account — distinct from `false`, which
   * is an explicit "off here even if the account says on". Passing `null` for
   * the whole map clears every override at once.
   */
  categoryOverrides?: Record<string, boolean | null> | null;
  quietHoursMode?: QuietHoursMode;
  quietStart?: string | null;
  quietEnd?: string | null;
  timeZone?: string | null;
}

/** Apply a settings patch. Returns null when the device isn't this user's. */
export async function updateDevice(
  db: DB,
  userId: string,
  deviceId: string,
  patch: DevicePatch,
): Promise<PushDevice | null> {
  const [existing] = await db
    .select()
    .from(schema.pushDevices)
    .where(and(eq(schema.pushDevices.id, deviceId), eq(schema.pushDevices.userId, userId)))
    .limit(1);
  if (!existing) return null;

  const overrides = mergeOverrides(existing.categoryOverrides, patch.categoryOverrides);

  const [row] = await db
    .update(schema.pushDevices)
    .set({
      label: patch.label === undefined ? existing.label : patch.label?.trim() || null,
      enabled: patch.enabled ?? existing.enabled,
      categoryOverrides: overrides,
      quietHoursMode: patch.quietHoursMode ?? existing.quietHoursMode,
      quietStart: patch.quietStart === undefined ? existing.quietStart : patch.quietStart,
      quietEnd: patch.quietEnd === undefined ? existing.quietEnd : patch.quietEnd,
      timeZone: patch.timeZone === undefined ? existing.timeZone : patch.timeZone,
      updatedAt: new Date(),
    })
    .where(eq(schema.pushDevices.id, deviceId))
    .returning();

  return row;
}

/**
 * Fold a patch into the stored override map.
 *
 * Merged rather than replaced so a client that only knows about today's
 * categories cannot drop the user's answer for one added since it loaded; keys
 * set to `null` are deleted, leaving the category to inherit from the account.
 */
export function mergeOverrides(
  existing: Record<string, boolean> | null,
  patch: Record<string, boolean | null> | null | undefined,
): Record<string, boolean> | null {
  if (patch === undefined) return existing;
  if (patch === null) return null;

  const merged: Record<string, boolean> = { ...(existing ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return Object.keys(merged).length > 0 ? merged : null;
}

/** Returns false when there was nothing of this user's to remove. */
export async function removeDevice(db: DB, userId: string, deviceId: string): Promise<boolean> {
  const rows = await db
    .delete(schema.pushDevices)
    .where(and(eq(schema.pushDevices.id, deviceId), eq(schema.pushDevices.userId, userId)))
    .returning({ id: schema.pushDevices.id });
  return rows.length > 0;
}

/** Remove by token — the sign-out path, where the client has no device id. */
export async function removeDeviceByToken(db: DB, userId: string, token: string): Promise<boolean> {
  const rows = await db
    .delete(schema.pushDevices)
    .where(and(eq(schema.pushDevices.userId, userId), eq(schema.pushDevices.token, token)))
    .returning({ id: schema.pushDevices.id });
  return rows.length > 0;
}

/** Note that a device is alive, without changing any of its settings. */
export async function touchDevice(db: DB, deviceId: string): Promise<void> {
  await db
    .update(schema.pushDevices)
    .set({ lastSeenAt: new Date() })
    .where(eq(schema.pushDevices.id, deviceId));
}
