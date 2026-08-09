import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { TEST_CATEGORY_ID } from "@/lib/notifications/categories";
import { sendNotification } from "@/lib/notifications/deliver";
import { getDevice } from "@/lib/notifications/settings";
import { buildSettingsView } from "@/lib/notifications/view";

/**
 * Send a test notification to one device and report exactly what happened.
 *
 * This is the endpoint that makes a broken pipeline visible: it runs the real
 * routing and the real transport, so a dead subscription fails here the same
 * way it fails at 3am — and the device's health columns are updated as a side
 * effect, which is why the response carries the whole refreshed view rather
 * than a bare ok/not-ok.
 *
 * A test is *not* exempt from quiet hours. Reporting "held until 08:00" is the
 * honest answer, and a test that ignored the setting would prove something the
 * user did not ask about.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { id } = await ctx.params;

    const db = getDb();
    const device = await getDevice(db, user.id, id);
    if (!device) return NextResponse.json({ error: "Device not found" }, { status: 404 });

    const report = await sendNotification(
      db,
      user.id,
      {
        category: TEST_CATEGORY_ID,
        title: "Whaikey test notification",
        body: "If you can read this, notifications are working on this device.",
        url: "/settings/notifications",
      },
      { deviceId: id },
    );

    const outcome = report.outcomes[0] ?? null;
    return NextResponse.json({
      outcome,
      settings: await buildSettingsView(db, user.id),
    });
  });
}
