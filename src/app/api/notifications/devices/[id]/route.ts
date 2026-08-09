import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { QUIET_HOURS_MODES } from "@/db/schema";
import { isKnownCategory } from "@/lib/notifications/categories";
import { invalidInput, readJson } from "@/lib/notifications/http";
import { isValidTimeOfDay, isValidTimeZone } from "@/lib/notifications/quiet-hours";
import { removeDevice, updateDevice } from "@/lib/notifications/registry";
import { buildSettingsView } from "@/lib/notifications/view";

/**
 * Per-device settings.
 *
 * This is where "different quiet times on my desktop and my phone" is actually
 * expressed: `quietHoursMode: "custom"` with the device's own window and zone.
 * A device is only ever addressable by the owning user — a foreign or missing
 * id is a 404 either way, so the endpoint never confirms that someone else's
 * device exists.
 */
const patchSchema = z
  .object({
    label: z.string().trim().max(60).nullable().optional(),
    enabled: z.boolean().optional(),
    // `null` for a key clears that override (back to following the account);
    // `null` for the whole map clears them all.
    categoryOverrides: z.record(z.string(), z.boolean().nullable()).nullable().optional(),
    quietHoursMode: z.enum(QUIET_HOURS_MODES).optional(),
    quietStart: z.string().refine(isValidTimeOfDay, "must be HH:MM").nullable().optional(),
    quietEnd: z.string().refine(isValidTimeOfDay, "must be HH:MM").nullable().optional(),
    timeZone: z.string().refine(isValidTimeZone, "must be a valid IANA time zone").nullable().optional(),
  })
  .strict();

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { id } = await ctx.params;

    const raw = await readJson(req);
    if (raw === null) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

    const parsed = patchSchema.safeParse(raw);
    if (!parsed.success) return invalidInput(parsed.error);

    const patch = parsed.data;
    if (patch.categoryOverrides) {
      const unknown = Object.keys(patch.categoryOverrides).filter((c) => !isKnownCategory(c));
      if (unknown.length > 0) {
        return NextResponse.json(
          { error: "Invalid input", details: [`Unknown categories: ${unknown.join(", ")}`] },
          { status: 400 },
        );
      }
    }

    // A custom window with only one end set would silently fall back to the
    // account's, which is exactly the confusion per-device settings exist to
    // remove. Require both, and reject rather than guess.
    if (patch.quietHoursMode === "custom" && (!patch.quietStart || !patch.quietEnd)) {
      return NextResponse.json(
        {
          error: "Invalid input",
          details: ["quietStart and quietEnd are required when quietHoursMode is 'custom'"],
        },
        { status: 400 },
      );
    }

    const device = await updateDevice(getDb(), user.id, id, patch);
    if (!device) return NextResponse.json({ error: "Device not found" }, { status: 404 });

    return NextResponse.json(await buildSettingsView(getDb(), user.id));
  });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { id } = await ctx.params;

    const removed = await removeDevice(getDb(), user.id, id);
    if (!removed) return NextResponse.json({ error: "Device not found" }, { status: 404 });

    return NextResponse.json(await buildSettingsView(getDb(), user.id));
  });
}
