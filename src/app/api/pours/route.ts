import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { BottleNotFoundError, listPours, logPour, pourInputSchema } from "@/lib/pours";

export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = pourInputSchema.safeParse(body);
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

    try {
      const { pour, note } = await logPour(getDb(), user.id, parsed.data);
      return NextResponse.json({ pour, note }, { status: 201 });
    } catch (err) {
      if (err instanceof BottleNotFoundError) {
        return NextResponse.json({ error: "Bottle not found" }, { status: 404 });
      }
      throw err;
    }
  });
}

export async function GET(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const url = new URL(req.url);
    const bottleId = url.searchParams.get("bottleId") ?? undefined;

    let limit: number | undefined;
    const rawLimit = url.searchParams.get("limit");
    if (rawLimit !== null) {
      limit = Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1) {
        return NextResponse.json({ error: "limit must be a positive integer" }, { status: 400 });
      }
    }

    const pours = await listPours(getDb(), user.id, { bottleId, limit });
    return NextResponse.json({ pours });
  });
}
