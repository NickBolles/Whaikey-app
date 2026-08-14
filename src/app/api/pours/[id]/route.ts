import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { POUR_VISIBILITIES } from "@/db/schema";
import { requireUser, withErrorHandling } from "@/lib/session";
import { SocialDisabledError, deletePour, getPour, updatePourVisibility } from "@/lib/pours";

type Ctx = { params: Promise<{ id: string }> };

const pourPatchSchema = z.object({ visibility: z.enum(POUR_VISIBILITIES) });

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

/** PATCH /api/pours/[id] { visibility } — owner-only social visibility change. */
export async function PATCH(req: Request, ctx: Ctx) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { id } = await ctx.params;

    const body = await req.json().catch(() => null);
    const parsed = pourPatchSchema.safeParse(body);
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
      updated = await updatePourVisibility(getDb(), user.id, id, parsed.data.visibility);
    } catch (err) {
      if (err instanceof SocialDisabledError) {
        return NextResponse.json({ error: "social_disabled" }, { status: 409 });
      }
      throw err;
    }
    if (!updated) {
      return NextResponse.json({ error: "Pour not found" }, { status: 404 });
    }
    return NextResponse.json({ visibility: updated.visibility });
  });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { id } = await ctx.params;
    const deleted = await deletePour(getDb(), user.id, id);
    if (!deleted) {
      return NextResponse.json({ error: "Pour not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  });
}
