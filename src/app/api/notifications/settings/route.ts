import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { isKnownCategory, getCategory } from "@/lib/notifications/categories";
import { invalidInput, readJson } from "@/lib/notifications/http";
import { isValidTimeOfDay, isValidTimeZone } from "@/lib/notifications/quiet-hours";
import { saveAccountPreferences } from "@/lib/notifications/settings";
import { buildSettingsView } from "@/lib/notifications/view";

/**
 * Account-level notification settings, plus everything the settings screen
 * needs to say whether push is actually working.
 *
 * GET returns the same view the server component renders, so the client can
 * refresh after a mutation without a full navigation and without a second
 * implementation of "is this device healthy".
 */
export async function GET() {
  return withErrorHandling(async () => {
    const user = await requireUser();
    return NextResponse.json(await buildSettingsView(getDb(), user.id));
  });
}

const patchSchema = z
  .object({
    categories: z.record(z.string(), z.boolean()).optional(),
    quietHoursEnabled: z.boolean().optional(),
    quietStart: z.string().refine(isValidTimeOfDay, "must be HH:MM").optional(),
    quietEnd: z.string().refine(isValidTimeOfDay, "must be HH:MM").optional(),
    timeZone: z.string().refine(isValidTimeZone, "must be a valid IANA time zone").optional(),
  })
  .strict();

export async function PATCH(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();

    const raw = await readJson(req);
    if (raw === null) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

    const parsed = patchSchema.safeParse(raw);
    if (!parsed.success) return invalidInput(parsed.error);

    const { categories, ...rest } = parsed.data;
    if (categories) {
      const unknown = Object.keys(categories).filter((id) => !isKnownCategory(id));
      if (unknown.length > 0) {
        return NextResponse.json(
          { error: "Invalid input", details: [`Unknown categories: ${unknown.join(", ")}`] },
          { status: 400 },
        );
      }
      // Critical categories cannot be switched off account-wide — a new-sign-in
      // alert the user never sees is a security hole, not a preference. They
      // remain silenceable per device, where the blast radius is one device.
      const criticalOff = Object.entries(categories).filter(
        ([id, on]) => !on && getCategory(id)?.critical,
      );
      if (criticalOff.length > 0) {
        return NextResponse.json(
          {
            error: "Invalid input",
            details: [
              `These types are always delivered and cannot be turned off for the whole account: ${criticalOff
                .map(([id]) => id)
                .join(", ")}`,
            ],
          },
          { status: 400 },
        );
      }
    }

    await saveAccountPreferences(getDb(), user.id, { ...rest, ...(categories ? { categories } : {}) });
    return NextResponse.json(await buildSettingsView(getDb(), user.id));
  });
}
