/**
 * Request-shaping helpers shared by the notification routes, so five endpoints
 * report a bad body the same way instead of five slightly different ways.
 */
import { NextResponse } from "next/server";
import type { z } from "zod";

export function invalidInput(error: z.ZodError): NextResponse {
  return NextResponse.json(
    {
      error: "Invalid input",
      details: error.issues.map((i) =>
        i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message,
      ),
    },
    { status: 400 },
  );
}

/** Parse a JSON body, or null when it isn't JSON at all. */
export async function readJson(req: Request): Promise<unknown | null> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}
