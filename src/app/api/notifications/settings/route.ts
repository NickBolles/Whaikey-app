import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { getNotificationSettings, notificationSettingsPatchSchema, updateNotificationSettings } from "@/lib/notify";
import { isPushConfigured } from "@/lib/push/send";

/** GET /api/notifications/settings — per-group switches, push switch, quiet hours. */
export async function GET() {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const settings = await getNotificationSettings(getDb(), user.id);
    return NextResponse.json({ ...settings, pushAvailable: isPushConfigured() });
  });
}

/** PATCH /api/notifications/settings — partial update; 400 on unknown keys or a lone quiet-hours bound. */
export async function PATCH(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const parsed = notificationSettingsPatchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    const settings = await updateNotificationSettings(getDb(), user.id, parsed.data);
    return NextResponse.json(settings);
  });
}
