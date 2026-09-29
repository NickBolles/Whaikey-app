import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { accountExportZip, buildAccountExport } from "@/lib/account-data";
import { appNow } from "@/lib/clock";
import { UnauthorizedError, getSessionUser, withErrorHandling } from "@/lib/session";

/**
 * GET /api/account/export — everything the signed-in account wrote, one tap,
 * no tier (WP-11; PLAN.md §3 "Own your data"; SEC-M5).
 *
 * `?format=json` (the default) is one document; `?format=csv` is a zip with a
 * CSV per section. Both are built from `ACCOUNT_DATA`, so a section cannot be
 * in one and missing from the other.
 *
 * `getSessionUser`, not `requireUser`, for the same reason as deletion: an
 * account the age gate has blocked is still owed its data (PLAN.md §9.1,
 * "export offered").
 */
export async function GET(req: Request) {
  return withErrorHandling(async () => {
    const user = await getSessionUser();
    if (!user) throw new UnauthorizedError();

    const format = new URL(req.url).searchParams.get("format") ?? "json";
    if (format !== "json" && format !== "csv") {
      return NextResponse.json({ error: "Invalid input", details: "format must be json or csv" }, { status: 400 });
    }

    const now = appNow();
    const exported = await buildAccountExport(getDb(), user.id, now);
    const stamp = now.toISOString().slice(0, 10);
    const headers = {
      // Personal data: never cached by anything between here and the person.
      "cache-control": "no-store",
    };

    if (format === "csv") {
      const zip = accountExportZip(exported);
      return new NextResponse(zip as BodyInit, {
        headers: {
          ...headers,
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="whaikey-export-${stamp}.zip"`,
        },
      });
    }
    return new NextResponse(JSON.stringify(exported, null, 2), {
      headers: {
        ...headers,
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="whaikey-export-${stamp}.json"`,
      },
    });
  });
}
