import { NextResponse } from "next/server";
import { getDb } from "@/db";
import {
  AppleNotificationError,
  appleNotificationAudiences,
  handleAppleNotification,
  verifyAppleNotification,
} from "@/lib/apple-notifications";
import { readJsonWithinLimit } from "@/lib/body-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/apple/notifications — Sign in with Apple server-to-server
 * notifications (src/lib/apple-notifications.ts). Register this URL for the
 * App ID in the Apple developer portal once Apple sign-in is configured.
 *
 * 404 until then (no audience to verify against). 400 for anything that does
 * not verify — Apple only retries on failure, and a forged or stale payload
 * should never be acted on. 200 once recorded, including a redelivery.
 */
export async function POST(request: Request) {
  const audiences = appleNotificationAudiences();
  if (!audiences) return NextResponse.json({ error: "Sign in with Apple is not configured" }, { status: 404 });

  const body = (await readJsonWithinLimit(request, 32_768).catch(() => null)) as { payload?: unknown } | null;
  let notification;
  try {
    notification = await verifyAppleNotification(body?.payload, { audiences });
  } catch (err) {
    if (err instanceof AppleNotificationError) {
      return NextResponse.json({ error: "invalid_notification" }, { status: 400 });
    }
    throw err;
  }
  const result = await handleAppleNotification(getDb(), notification);
  return NextResponse.json({ ok: true, duplicate: result.duplicate });
}
