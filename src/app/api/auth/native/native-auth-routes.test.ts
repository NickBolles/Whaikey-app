import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { schema } from "@/db";
import type { DB } from "@/db";
import { createTestUser, mockSessionModule, setSessionUser, setupTestDb } from "@/test/helpers";
import { codeChallengeFor, startNativeAuthRequest } from "@/lib/native-auth";

vi.mock("@/lib/session", async () => mockSessionModule());

interface SignInSocialArgs {
  body: { provider: string; callbackURL: string; disableRedirect: boolean };
  headers: Headers;
}
const signInSocial = vi.fn<(args: SignInSocialArgs) => Promise<{ url: string }>>(async () => ({
  url: "https://accounts.google.com/o/oauth2/auth?x=1",
}));
vi.mock("@/lib/auth", () => ({ auth: { options: {}, api: { signInSocial } } }));

const SESSION_COOKIE = "better-auth.session_token";
vi.mock("better-auth/cookies", () => ({
  getCookies: () => ({ sessionToken: { name: SESSION_COOKIE } }),
}));

import { GET as START } from "@/app/api/auth/native/start/route";
import { GET as COMPLETE } from "@/app/api/auth/native/complete/route";
import { GET as EXCHANGE } from "@/app/api/auth/native/exchange/route";

/**
 * The three hops of native sign-in (docs/NATIVE_APP.md §2.3), tested for what
 * must *not* work. The callback leg runs over `whaikey://`, a scheme any app on
 * the device can register, so these routes have to assume the code is
 * intercepted and the callback is forged (review SEC-H1/SEC-H2).
 */
const ORIGIN = "http://localhost:3000";
const VERIFIER = "a-verifier-only-the-app-that-started-this-has";
const CHALLENGE = codeChallengeFor(VERIFIER);
const STATE = "state-nonce-from-the-app-0123456789abcdef";
const COOKIE_VALUE = "token-abc.signature-xyz";

function get(path: string, cookies: Record<string, string> = {}): NextRequest {
  const headers = new Headers();
  const jar = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  if (jar) headers.set("cookie", jar);
  return new NextRequest(new Request(`${ORIGIN}${path}`, { headers }));
}

/** The `whaikey://auth/callback?...` params from a /complete redirect. */
function callbackParams(res: Response): URLSearchParams {
  const location = res.headers.get("location") ?? "";
  return new URLSearchParams(location.slice(location.indexOf("?") + 1));
}

let db: DB;
let userId: string;

beforeEach(async () => {
  db = await setupTestDb();
  const user = await createTestUser(db);
  userId = user.id;
  setSessionUser(user);
  signInSocial.mockClear();
});

describe("GET /api/auth/native/start", () => {
  it("records the challenge and state, and carries the request id into the callback", async () => {
    const res = await START(
      get(`/api/auth/native/start?provider=google&code_challenge=${CHALLENGE}&state=${STATE}`),
    );

    expect(res.status).toBe(307);
    const [row] = await db.select().from(schema.nativeAuthRequests);
    expect(row).toMatchObject({ codeChallenge: CHALLENGE, state: STATE });

    expect(signInSocial.mock.calls[0]?.[0].body.callbackURL).toBe(
      `/api/auth/native/complete?request=${encodeURIComponent(row.id)}`,
    );
  });

  it("parks the return path server-side rather than in the callback URL", async () => {
    await START(
      get(
        `/api/auth/native/start?provider=google&code_challenge=${CHALLENGE}&state=${STATE}&next=%2Fadd%2Fsasha`,
      ),
    );
    const [row] = await db.select().from(schema.nativeAuthRequests);
    expect(row.next).toBe("/add/sasha");
    // Nothing about where sign-in lands can be rewritten mid-flight.
    expect(signInSocial.mock.calls[0]?.[0].body.callbackURL).not.toContain("sasha");
  });

  it("drops an off-origin return path instead of carrying it", async () => {
    await START(
      get(
        `/api/auth/native/start?provider=google&code_challenge=${CHALLENGE}&state=${STATE}&next=https%3A%2F%2Fevil.example%2Fx`,
      ),
    );
    const [row] = await db.select().from(schema.nativeAuthRequests);
    expect(row.next).toBeNull();
  });

  it("refuses to start without PKCE", async () => {
    const noChallenge = await START(get(`/api/auth/native/start?provider=google&state=${STATE}`));
    expect(noChallenge.status).toBe(400);
    const noState = await START(
      get(`/api/auth/native/start?provider=google&code_challenge=${CHALLENGE}`),
    );
    expect(noState.status).toBe(400);
    // A challenge too short to be worth binding to is not a challenge.
    const weak = await START(
      get(`/api/auth/native/start?provider=google&code_challenge=short&state=${STATE}`),
    );
    expect(weak.status).toBe(400);

    await expect(db.select().from(schema.nativeAuthRequests)).resolves.toHaveLength(0);
    expect(signInSocial).not.toHaveBeenCalled();
  });

  it("refuses providers that are not configured social login", async () => {
    const res = await START(
      get(`/api/auth/native/start?provider=credentials&code_challenge=${CHALLENGE}&state=${STATE}`),
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/auth/native/complete", () => {
  async function pending(next?: string) {
    return startNativeAuthRequest({ codeChallenge: CHALLENGE, state: STATE, next });
  }

  it("mints a code bound to the request, and echoes the state back", async () => {
    const id = await pending();
    const res = await COMPLETE(
      get(`/api/auth/native/complete?request=${id}`, { [SESSION_COOKIE]: COOKIE_VALUE }),
    );

    expect(res.status).toBe(302);
    const params = callbackParams(res);
    expect(params.get("code")).toBeTruthy();
    expect(params.get("state")).toBe(STATE);

    const [row] = await db.select().from(schema.nativeAuthCodes);
    expect(row).toMatchObject({ userId, codeChallenge: CHALLENGE });
    // The cookie is a weeks-long credential; it is not what sits in the table.
    expect(row.sessionCookie).not.toContain("token-abc");
  });

  /**
   * The heart of SEC-H1. Before this, `/complete` was a GET that handed a
   * session-equivalent code to whoever held a browser session — and SameSite=Lax
   * means a cross-site top-level navigation carries that session.
   */
  it("mints nothing for a callback no /start ever asked for", async () => {
    const res = await COMPLETE(
      get("/api/auth/native/complete", { [SESSION_COOKIE]: COOKIE_VALUE }),
    );
    expect(callbackParams(res).get("error")).toBe("no_request");
    expect(callbackParams(res).get("code")).toBeNull();
    // No state either, so the app has nothing to accept this against.
    expect(callbackParams(res).get("state")).toBeNull();
    await expect(db.select().from(schema.nativeAuthCodes)).resolves.toHaveLength(0);
  });

  it("mints nothing for an unknown or already-answered request id", async () => {
    const id = await pending();
    await COMPLETE(get(`/api/auth/native/complete?request=${id}`, { [SESSION_COOKIE]: COOKIE_VALUE }));

    const replay = await COMPLETE(
      get(`/api/auth/native/complete?request=${id}`, { [SESSION_COOKIE]: COOKIE_VALUE }),
    );
    expect(callbackParams(replay).get("error")).toBe("no_request");
    const forged = await COMPLETE(
      get("/api/auth/native/complete?request=made-up", { [SESSION_COOKIE]: COOKIE_VALUE }),
    );
    expect(callbackParams(forged).get("error")).toBe("no_request");
    await expect(db.select().from(schema.nativeAuthCodes)).resolves.toHaveLength(1);
  });

  it("reports a cancelled sign-in with the state, so the app can show it", async () => {
    setSessionUser(null);
    const id = await pending();
    const res = await COMPLETE(get(`/api/auth/native/complete?request=${id}`));

    const params = callbackParams(res);
    expect(params.get("error")).toBe("not_signed_in");
    // The app drops any callback it can't match, error callbacks included.
    expect(params.get("state")).toBe(STATE);
  });

  it("returns the parked return path so a scanned link survives sign-in", async () => {
    const id = await pending("/add/sasha");
    const res = await COMPLETE(
      get(`/api/auth/native/complete?request=${id}`, { [SESSION_COOKIE]: COOKIE_VALUE }),
    );
    expect(callbackParams(res).get("next")).toBe("/add/sasha");
  });
});

describe("GET /api/auth/native/exchange", () => {
  /** Run start → complete and hand back what the app would have received. */
  async function codeFor(next?: string): Promise<string> {
    const id = await startNativeAuthRequest({ codeChallenge: CHALLENGE, state: STATE, next });
    const res = await COMPLETE(
      get(`/api/auth/native/complete?request=${id}`, { [SESSION_COOKIE]: COOKIE_VALUE }),
    );
    return callbackParams(res).get("code") ?? "";
  }

  it("sets the session cookie in the WebView and lands on the return path", async () => {
    const code = await codeFor("/add/sasha");
    const res = await EXCHANGE(
      get(`/api/auth/native/exchange?code=${code}&code_verifier=${VERIFIER}&next=%2Fadd%2Fsasha`),
    );

    expect(res.headers.get("location")).toBe(`${ORIGIN}/add/sasha`);
    // Better Auth signs its cookie, so the exact value has to come back out.
    expect(res.cookies.get(SESSION_COOKIE)?.value).toBe(COOKIE_VALUE);
  });

  /**
   * The interception case. Another app claimed `whaikey://`, took the code off
   * the callback, and is now trying to spend it. It never had the verifier.
   */
  it("refuses a code presented without the verifier that started the flow", async () => {
    const code = await codeFor();
    const stolen = await EXCHANGE(get(`/api/auth/native/exchange?code=${code}`));
    expect(stolen.headers.get("location")).toContain("/sign-in?error=expired");
    expect(stolen.cookies.get(SESSION_COOKIE)).toBeUndefined();

    const guessed = await EXCHANGE(
      get(`/api/auth/native/exchange?code=${code}&code_verifier=a-guess`),
    );
    expect(guessed.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });

  it("works exactly once, and destroys the row doing it", async () => {
    const code = await codeFor();
    const first = await EXCHANGE(
      get(`/api/auth/native/exchange?code=${code}&code_verifier=${VERIFIER}`),
    );
    expect(first.cookies.get(SESSION_COOKIE)?.value).toBe(COOKIE_VALUE);

    const replay = await EXCHANGE(
      get(`/api/auth/native/exchange?code=${code}&code_verifier=${VERIFIER}`),
    );
    expect(replay.cookies.get(SESSION_COOKIE)).toBeUndefined();
    await expect(db.select().from(schema.nativeAuthCodes)).resolves.toHaveLength(0);
  });

  it("never redirects off-origin, whatever `next` says", async () => {
    const code = await codeFor();
    const res = await EXCHANGE(
      get(
        `/api/auth/native/exchange?code=${code}&code_verifier=${VERIFIER}&next=https%3A%2F%2Fevil.example%2Fx`,
      ),
    );
    expect(new URL(res.headers.get("location") ?? "").origin).toBe(ORIGIN);
  });

  it("sends an unknown code back to sign-in rather than erroring", async () => {
    const res = await EXCHANGE(
      get(`/api/auth/native/exchange?code=never-issued&code_verifier=${VERIFIER}`),
    );
    expect(res.headers.get("location")).toContain("/sign-in?error=expired");
  });
});
