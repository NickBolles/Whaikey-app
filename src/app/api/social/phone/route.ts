import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { InvalidPhoneError } from "@/lib/phone";
import { requireUser, withErrorHandling } from "@/lib/session";
import {
  PhoneTakenError,
  SocialDisabledError,
  clearPhone,
  phoneDiscoverablePatchSchema,
  phoneSetSchema,
  setPhone,
  setPhoneDiscoverable,
} from "@/lib/social";

/**
 * POST /api/social/phone { phone, discoverable } — set/replace the caller's
 * number. 400 invalid_phone for a malformed number or body; 409
 * profile_required (no profile yet), phone_taken (another account already
 * claimed this hash), or social_disabled (discoverable=true while stepped
 * back). Never echoes the phone back — only the last-2 + discoverable flag.
 */
export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const body = await req.json().catch(() => null);
    const parsed = phoneSetSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_phone" }, { status: 400 });
    }

    let result;
    try {
      result = await setPhone(getDb(), user.id, parsed.data.phone, parsed.data.discoverable);
    } catch (err) {
      if (err instanceof InvalidPhoneError) {
        return NextResponse.json({ error: "invalid_phone" }, { status: 400 });
      }
      if (err instanceof PhoneTakenError) {
        return NextResponse.json({ error: "phone_taken" }, { status: 409 });
      }
      if (err instanceof SocialDisabledError) {
        return NextResponse.json({ error: "social_disabled" }, { status: 409 });
      }
      throw err;
    }
    if (!result) {
      return NextResponse.json({ error: "profile_required" }, { status: 409 });
    }
    return NextResponse.json(result);
  });
}

/** DELETE /api/social/phone — always allowed (lowering exposure). { removed: boolean }. */
export async function DELETE() {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const removed = await clearPhone(getDb(), user.id);
    return NextResponse.json({ removed });
  });
}

/**
 * PATCH /api/social/phone { discoverable } — flip discoverability without
 * touching the number. 404 when there's no profile; 409 social_disabled when
 * raising discoverable=true while stepped back.
 */
export async function PATCH(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const body = await req.json().catch(() => null);
    const parsed = phoneDiscoverablePatchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }

    let updated;
    try {
      updated = await setPhoneDiscoverable(getDb(), user.id, parsed.data.discoverable);
    } catch (err) {
      if (err instanceof SocialDisabledError) {
        return NextResponse.json({ error: "social_disabled" }, { status: 409 });
      }
      throw err;
    }
    if (!updated) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ phoneDiscoverable: parsed.data.discoverable });
  });
}
