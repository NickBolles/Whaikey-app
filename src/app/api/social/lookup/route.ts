import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { InvalidPhoneError } from "@/lib/phone";
import { requireUser, withErrorHandling } from "@/lib/session";
import { RateLimitedError, findProfileByPhone, phoneLookupSchema } from "@/lib/social";

/**
 * POST /api/social/lookup { phone } — exact phone lookup, the first hop of
 * the phone add path. No profile required (finding people is how you start
 * before claiming a handle); requires auth so the durable rate limit has a
 * caller to key off. `profile: null` covers every non-match reason — no such
 * number, not discoverable, stepped-back owner, blocked either way — by
 * design, so the response is never an oracle. 400 invalid_phone; 429
 * rate_limited past PHONE_LOOKUP_LIMIT_PER_HOUR.
 */
export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const body = await req.json().catch(() => null);
    const parsed = phoneLookupSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_phone" }, { status: 400 });
    }

    let profile;
    try {
      profile = await findProfileByPhone(getDb(), user.id, parsed.data.phone);
    } catch (err) {
      if (err instanceof InvalidPhoneError) {
        return NextResponse.json({ error: "invalid_phone" }, { status: 400 });
      }
      if (err instanceof RateLimitedError) {
        return NextResponse.json({ error: "rate_limited" }, { status: 429 });
      }
      throw err;
    }
    return NextResponse.json({ profile });
  });
}
