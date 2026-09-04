import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { registerPushDevice } from "@/lib/push-devices";

/**
 * Push device registration (docs/NATIVE_APP.md §3.2).
 *
 * A token identifies a device install, not a person, so it can legitimately
 * move between users — a shared phone, or someone signing out and a friend
 * signing in. What it is *not* is proof that the caller is holding the device:
 * re-registering used to reassign the token to whoever asked, so anyone who
 * learned a victim's token took their notifications with it (review SEC-M6).
 * `registerPushDevice` holds the rule; see `src/lib/push-devices.ts`.
 */
const bodySchema = z.object({
  token: z.string().min(1).max(512),
  platform: z.enum(["ios", "android"]),
});

export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid input",
          details: parsed.error.issues.map((i) =>
            i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message,
          ),
        },
        { status: 400 },
      );
    }

    const outcome = await registerPushDevice(
      getDb(),
      user.id,
      parsed.data.token,
      parsed.data.platform,
    );

    if (outcome === "claimed_by_another") {
      // Not an oracle worth worrying about: the caller already holds the token,
      // which is the thing being protected. Saying so lets the app explain why
      // notifications are off rather than silently never arriving.
      return NextResponse.json(
        {
          error: "token_claimed",
          message: "This device is still registered to another account.",
        },
        { status: 409 },
      );
    }

    return NextResponse.json({ registered: true }, { status: 201 });
  });
}

/** Unregister every device for this user — used on sign-out. */
export async function DELETE(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const token = new URL(req.url).searchParams.get("token");

    const db = getDb();
    await db
      .delete(schema.pushDevices)
      .where(
        token
          ? and(eq(schema.pushDevices.userId, user.id), eq(schema.pushDevices.token, token))
          : eq(schema.pushDevices.userId, user.id),
      );

    return NextResponse.json({ unregistered: true });
  });
}
