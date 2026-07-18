import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { deletePour, getPour } from "@/lib/pours";

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
