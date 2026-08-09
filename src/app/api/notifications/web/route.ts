import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { invalidInput, readJson } from "@/lib/notifications/http";
import { isValidTimeZone } from "@/lib/notifications/quiet-hours";
import { registerDevice, removeDeviceByToken } from "@/lib/notifications/registry";
import { toDeviceView } from "@/lib/notifications/view";
import { getPushConfigStatus } from "@/lib/notifications/config";
import { loadAccountPreferences } from "@/lib/notifications/settings";

/**
 * Web push subscription registration (the browser half of the same table the
 * native app writes to via /api/native/push-token).
 *
 * The browser sends the PushSubscription verbatim: `endpoint` is the address
 * the push service will accept messages at, and `keys.p256dh` / `keys.auth` are
 * the ECDH material every payload is encrypted to. Without both keys a
 * subscription can be stored but never used, so they are required rather than
 * optional — a row that cannot receive is worse than no row, because it looks
 * like a working device on the settings screen.
 *
 * The endpoint doubles as the device's unique token, which the Push API already
 * guarantees to be unique per subscription.
 */
const subscribeSchema = z
  .object({
    endpoint: z.string().url().max(2048),
    keys: z.object({
      p256dh: z.string().min(1).max(255),
      auth: z.string().min(1).max(255),
    }),
    label: z.string().trim().max(60).optional(),
    /** The browser's own zone, so this device's quiet hours read correctly. */
    timeZone: z.string().refine(isValidTimeZone, "must be a valid IANA time zone").optional(),
  })
  .strict();

export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();

    const raw = await readJson(req);
    if (raw === null) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

    const parsed = subscribeSchema.safeParse(raw);
    if (!parsed.success) return invalidInput(parsed.error);

    const db = getDb();
    const device = await registerDevice(db, user.id, {
      token: parsed.data.endpoint,
      platform: "web",
      p256dh: parsed.data.keys.p256dh,
      authSecret: parsed.data.keys.auth,
      userAgent: req.headers.get("user-agent"),
      label: parsed.data.label ?? null,
      timeZone: parsed.data.timeZone ?? null,
    });

    const account = await loadAccountPreferences(db, user.id);
    return NextResponse.json(
      { device: toDeviceView(device, account, getPushConfigStatus(), new Date()) },
      { status: 201 },
    );
  });
}

/** Unsubscribe this browser — the endpoint identifies which row to drop. */
export async function DELETE(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const endpoint = new URL(req.url).searchParams.get("endpoint");
    if (!endpoint) {
      return NextResponse.json(
        { error: "Invalid input", details: ["endpoint query parameter is required"] },
        { status: 400 },
      );
    }

    const removed = await removeDeviceByToken(getDb(), user.id, endpoint);
    return NextResponse.json({ unregistered: removed });
  });
}
