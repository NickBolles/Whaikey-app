import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";

/**
 * Push device registration (docs/NATIVE_APP.md §3.2).
 *
 * A token identifies a device install, not a person, so it can legitimately move
 * between users — a shared phone, or someone signing out and a friend signing
 * in. `token` is therefore unique on its own and re-registering reassigns it,
 * which also stops the previous user's notifications from following the device.
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

    const db = getDb();
    const now = new Date();
    await db
      .insert(schema.pushDevices)
      .values({
        id: crypto.randomUUID(),
        userId: user.id,
        token: parsed.data.token,
        platform: parsed.data.platform,
      })
      .onConflictDoUpdate({
        target: schema.pushDevices.token,
        set: { userId: user.id, platform: parsed.data.platform, updatedAt: now },
      });

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
