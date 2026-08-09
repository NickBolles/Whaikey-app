import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { invalidInput, readJson } from "@/lib/notifications/http";
import { isValidTimeZone } from "@/lib/notifications/quiet-hours";
import { registerDevice, removeDevice, removeDeviceByToken } from "@/lib/notifications/registry";
import { eq } from "drizzle-orm";
import { schema } from "@/db";

/**
 * Native push device registration (docs/NATIVE_APP.md §3.2).
 *
 * Registration goes through the shared registry so an iPhone and a browser end
 * up as the same kind of row, subject to the same quiet hours, category
 * routing, and health tracking. The device-side half lives in
 * `src/lib/native/push.ts`.
 *
 * A token identifies a device install, not a person, so it can legitimately
 * move between users — a shared phone, or someone signing out and a friend
 * signing in. `token` is unique on its own and re-registering reassigns it,
 * which also stops the previous user's notifications from following the device.
 */
const bodySchema = z
  .object({
    token: z.string().min(1).max(512),
    platform: z.enum(["ios", "android"]),
    /** Device name from the OS ("Nick's iPhone"), when the shell can read it. */
    label: z.string().trim().max(60).optional(),
    /** The handset's own zone — it travels, and its quiet hours travel with it. */
    timeZone: z.string().refine(isValidTimeZone, "must be a valid IANA time zone").optional(),
  })
  .strict();

export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();

    const raw = await readJson(req);
    if (raw === null) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) return invalidInput(parsed.error);

    const device = await registerDevice(getDb(), user.id, {
      token: parsed.data.token,
      platform: parsed.data.platform,
      userAgent: req.headers.get("user-agent"),
      label: parsed.data.label ?? null,
      timeZone: parsed.data.timeZone ?? null,
    });

    return NextResponse.json({ registered: true, deviceId: device.id }, { status: 201 });
  });
}

/**
 * Unregister. With `?token=` (or `?deviceId=`) just that device goes; with
 * neither, every device for the user does — the sign-out path, where the client
 * wants to be sure nothing keeps arriving on hardware it is walking away from.
 */
export async function DELETE(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const params = new URL(req.url).searchParams;
    const token = params.get("token");
    const deviceId = params.get("deviceId");

    if (token) {
      await removeDeviceByToken(getDb(), user.id, token);
    } else if (deviceId) {
      await removeDevice(getDb(), user.id, deviceId);
    } else {
      await getDb().delete(schema.pushDevices).where(eq(schema.pushDevices.userId, user.id));
    }

    return NextResponse.json({ unregistered: true });
  });
}
