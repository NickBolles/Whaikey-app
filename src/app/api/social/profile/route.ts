import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import {
  createProfile,
  getOwnProfile,
  getSocialPrefs,
  HandleTakenError,
  InvalidHandleError,
  makeEverythingPrivate,
  profileCreateSchema,
  profileUpdateSchema,
  setSocialEnabled,
  AccountSuspendedError,
  SocialDisabledError,
  updateProfile,
} from "@/lib/social";

const profilePatchSchema = profileUpdateSchema.extend({ socialEnabled: z.boolean().optional() });

function zodDetails(err: z.ZodError): string[] {
  return err.issues.map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message));
}

/** GET /api/social/profile — the caller's own profile (or null) + social prefs. */
export async function GET() {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const db = getDb();
    const [profile, prefs] = await Promise.all([getOwnProfile(db, user.id), getSocialPrefs(db, user.id)]);
    return NextResponse.json({ profile, prefs });
  });
}

/**
 * POST /api/social/profile — lazily claim a handle. 409 profile_exists if the
 * caller already has one; 400 invalid_handle / 409 handle_taken from the lib.
 */
export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const body = await req.json().catch(() => null);
    const parsed = profileCreateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid input", details: zodDetails(parsed.error) }, { status: 400 });
    }

    const db = getDb();
    const existing = await getOwnProfile(db, user.id);
    if (existing) {
      return NextResponse.json({ error: "profile_exists" }, { status: 409 });
    }

    try {
      let profile = await createProfile(db, { id: user.id, name: user.name, image: user.image }, parsed.data.handle);
      const { displayName, bio, homeRegion, isPublic, discoverable } = parsed.data;
      if (
        displayName !== undefined ||
        bio !== undefined ||
        homeRegion !== undefined ||
        isPublic !== undefined ||
        discoverable !== undefined
      ) {
        const updated = await updateProfile(db, user.id, { displayName, bio, homeRegion, isPublic, discoverable });
        if (updated) profile = updated;
      }
      return NextResponse.json(profile, { status: 201 });
    } catch (err) {
      if (err instanceof InvalidHandleError) {
        return NextResponse.json({ error: "invalid_handle" }, { status: 400 });
      }
      if (err instanceof HandleTakenError) {
        return NextResponse.json({ error: "handle_taken" }, { status: 409 });
      }
      throw err;
    }
  });
}

/**
 * PATCH /api/social/profile — edit profile fields; `socialEnabled` is the
 * reversible US-11 step-back switch, applied via setSocialEnabled. 404 when
 * the caller has no profile yet.
 */
export async function PATCH(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const body = await req.json().catch(() => null);
    const parsed = profilePatchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid input", details: zodDetails(parsed.error) }, { status: 400 });
    }

    const db = getDb();
    const { socialEnabled, ...profilePatch } = parsed.data;
    // Re-enable first so "turn social back on and go public" works in one
    // PATCH; the exposure gate in updateProfile then sees the new state.
    if (socialEnabled === true) {
      try {
        await setSocialEnabled(db, user.id, true);
      } catch (err) {
        if (err instanceof AccountSuspendedError) {
          // A suspension is not the account's to lift (PLAN.md §9.4), and this
          // is the toggle it would reach for.
          return NextResponse.json({ error: "account_suspended" }, { status: 403 });
        }
        throw err;
      }
    }
    let updated;
    try {
      updated = await updateProfile(db, user.id, profilePatch);
    } catch (err) {
      if (err instanceof SocialDisabledError) {
        return NextResponse.json({ error: "social_disabled" }, { status: 409 });
      }
      throw err;
    }
    if (!updated) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    let profile = updated;
    if (socialEnabled === false) {
      // Disabling social is never a bare flag flip: it always runs the full
      // US-11 reset (pours private, links revoked, profile unlisted) so no
      // API path can report "social off" while bearer links stay live.
      await makeEverythingPrivate(db, user.id);
      profile = (await getOwnProfile(db, user.id)) ?? updated;
    }
    return NextResponse.json(profile);
  });
}
