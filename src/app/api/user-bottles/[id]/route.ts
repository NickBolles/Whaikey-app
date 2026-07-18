import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { toUserBottleValues, userBottleUpdateSchema } from "@/lib/bar";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function findOwnedRow(id: string, userId: string) {
  const db = getDb();
  const row = await db.query.userBottles.findFirst({ where: eq(schema.userBottles.id, id) });
  if (!row || row.userId !== userId) return null;
  return row;
}

/**
 * PATCH /api/user-bottles/[id] — partial update. 404 unless the row belongs to
 * the signed-in user. Status "finished" forces fillLevel 0; status "open"
 * defaults fillLevel to 100 when the row was previously sealed/null.
 */
export async function PATCH(req: Request, ctx: Ctx) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const parsed = userBottleUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const existing = await findOwnedRow(id, user.id);
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const input = parsed.data;
    const values = toUserBottleValues(input);
    if (input.relationship !== undefined) values.relationship = input.relationship;
    if (input.status === "finished") {
      values.fillLevel = 0;
    } else if (
      input.status === "open" &&
      input.fillLevel === undefined &&
      (existing.status === "sealed" || existing.status == null)
    ) {
      values.fillLevel = 100;
    }

    const db = getDb();
    const [row] = await db
      .update(schema.userBottles)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(schema.userBottles.id, id))
      .returning();
    return NextResponse.json(row);
  });
}

/** DELETE /api/user-bottles/[id] — remove the row (404 if not owner). */
export async function DELETE(_req: Request, ctx: Ctx) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { id } = await ctx.params;

    const existing = await findOwnedRow(id, user.id);
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    await getDb().delete(schema.userBottles).where(eq(schema.userBottles.id, id));
    return NextResponse.json({ ok: true });
  });
}
