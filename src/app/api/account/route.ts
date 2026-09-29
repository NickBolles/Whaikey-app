import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { deleteAccount } from "@/lib/account-data";
import { DELETE_CONFIRMATION, isDeleteConfirmation } from "@/lib/account-confirm";
import { UnauthorizedError, getSessionUser, withErrorHandling } from "@/lib/session";

const bodySchema = z.object({ confirm: z.string() });

/**
 * Better Auth's cookies, in both spellings: `__Secure-` in production over
 * HTTPS, bare in development. The session rows are already gone with the
 * account, so these are dead either way; clearing them means the browser
 * stops sending a token for an account that no longer exists.
 */
const AUTH_COOKIES = ["session_token", "session_data", "dont_remember"].flatMap((name) => [
  `better-auth.${name}`,
  `__Secure-better-auth.${name}`,
]);

/**
 * DELETE /api/account — hard-delete the signed-in account (WP-11, SEC-M5).
 *
 * Body `{ "confirm": "DELETE" }`. What goes, what is unlinked and what is
 * kept is `ACCOUNT_DATA` in `src/lib/account-data.ts`, one transaction.
 *
 * Reached through `getSessionUser`, not `requireUser`: the age gate must not
 * stand between somebody and deleting their account. An account the gate has
 * blocked is exactly the one PLAN.md §9.1 says gets "deletion after notice",
 * and one that never answered has every right to leave without answering.
 * A JSON body is required, which also means a cross-site form cannot send
 * this: the browser will not post `application/json` across origins without a
 * preflight this route never grants.
 */
export async function DELETE(req: Request) {
  return withErrorHandling(async () => {
    const user = await getSessionUser();
    if (!user) throw new UnauthorizedError();

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid input", details: parsed.error.issues }, { status: 400 });
    }
    if (!isDeleteConfirmation(parsed.data.confirm)) {
      return NextResponse.json(
        { error: "confirmation_required", expected: DELETE_CONFIRMATION },
        { status: 400 },
      );
    }

    const deleted = await deleteAccount(getDb(), user.id);
    if (!deleted) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const res = NextResponse.json({ deleted: true });
    for (const name of AUTH_COOKIES) {
      res.cookies.set(name, "", {
        path: "/",
        maxAge: 0,
        httpOnly: true,
        sameSite: "lax",
        secure: name.startsWith("__Secure-"),
      });
    }
    return res;
  });
}
