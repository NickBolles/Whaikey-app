import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import {
  PendingBottleError,
  SocialDisabledError,
  deletePour,
  getPour,
  ModeratedError,
  pourEditSchema,
  updatePourEntry,
} from "@/lib/pours";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { id } = await ctx.params;
    const result = await getPour(getDb(), user.id, id);
    if (!result) {
      return NextResponse.json({ error: "Pour not found" }, { status: 404 });
    }
    return NextResponse.json({ pour: result.pour, bottleName: result.bottleName, note: result.note });
  });
}

/**
 * PATCH /api/pours/[id] — owner-only edit of the journal entry: any of
 * { rating, servingStyle, note, visibility }. Responds with the entry and
 * `previous` (the pre-edit values of the fields sent) for the client's Undo.
 */
export async function PATCH(req: Request, ctx: Ctx) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { id } = await ctx.params;

    const body = await req.json().catch(() => null);
    const parsed = pourEditSchema.safeParse(body);
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

    let updated;
    try {
      updated = await updatePourEntry(getDb(), user.id, id, parsed.data);
    } catch (err) {
      if (err instanceof SocialDisabledError) {
        return NextResponse.json({ error: "social_disabled" }, { status: 409 });
      }
      if (err instanceof ModeratedError) {
        return NextResponse.json(
          {
            error: "moderated",
            message:
              "A moderator hid this note. It stays in your journal; ask through support if you think that was wrong.",
          },
          { status: 409 },
        );
      }
      if (err instanceof PendingBottleError) {
        return NextResponse.json(
          {
            error: "pending_bottle",
            message: "That bottle is waiting to be reviewed, so this note stays private for now.",
          },
          { status: 409 },
        );
      }
      throw err;
    }
    if (!updated) {
      return NextResponse.json({ error: "Pour not found" }, { status: 404 });
    }
    return NextResponse.json({
      visibility: updated.pour.visibility,
      pour: {
        id: updated.pour.id,
        rating: updated.pour.rating,
        servingStyle: updated.pour.servingStyle,
        visibility: updated.pour.visibility,
        editedAt: updated.pour.editedAt?.toISOString() ?? null,
      },
      note: updated.note
        ? {
            nose: updated.note.nose,
            palate: updated.note.palate,
            finish: updated.note.finish,
            freeform: updated.note.freeform,
            flavorTags: updated.note.flavorTags,
          }
        : null,
      previous: updated.previous,
    });
  });
}

export async function DELETE(req: Request, ctx: Ctx) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { id } = await ctx.params;
    // `?undo=1`: the toast's Undo of a pour just logged also reverses what it
    // did to the shelf — fill taken, a "tried" row filed (lib/pours deletePour).
    const undo = new URL(req.url).searchParams.get("undo") === "1";
    const deleted = await deletePour(getDb(), user.id, id, { undo });
    if (!deleted) {
      return NextResponse.json({ error: "Pour not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  });
}
