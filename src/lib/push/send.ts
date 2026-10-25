import { createSign } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { DB } from "@/db";
import { pushDevices } from "@/db/schema";

/**
 * Push transport (whiskey-build-tracks Track D4's contract, shipped by the
 * social track so notifications have a real sender): FCM HTTP v1, which also
 * delivers to iOS through the APNs key uploaded to the Firebase project.
 *
 * Configuration is one env var, `FCM_SERVICE_ACCOUNT_JSON` — the service
 * account key file's JSON (project_id, client_email, private_key). Unset means
 * push is off and every notification stays in the in-app inbox; nothing else
 * changes. No SDK: an RS256 JWT is exchanged for an OAuth token with
 * node:crypto, so there is no dependency and no paid service.
 *
 * Tokens FCM reports as gone (`UNREGISTERED`, 404) are pruned, which is the
 * only way a stale registration ever leaves `push_devices` besides sign-out.
 */

export interface PushMessage {
  category: string;
  title: string;
  body: string;
  /** Same-origin path; the shell navigates there when the notification is tapped. */
  deepLink: string;
}

export type PushResult = "sent" | "no_device" | "failed" | "unconfigured";

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: FetchLike | null = null;
let accessToken: { value: string; expiresAt: number } | null = null;

/** Tests swap the network; production uses the global fetch. */
export function setPushFetchForTests(f: FetchLike | null): void {
  fetchImpl = f;
  accessToken = null;
}

function doFetch(input: string, init?: RequestInit): Promise<Response> {
  return (fetchImpl ?? fetch)(input, init);
}

export function readServiceAccount(env: Record<string, string | undefined> = process.env): ServiceAccount | null {
  const raw = env.FCM_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ServiceAccount>;
    if (!parsed.project_id || !parsed.client_email || !parsed.private_key) return null;
    return parsed as ServiceAccount;
  } catch {
    return null;
  }
}

export function isPushConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return readServiceAccount(env) !== null;
}

const b64url = (input: string | Buffer) => Buffer.from(input).toString("base64url");

/** A signed service-account assertion for Google's OAuth token endpoint. */
export function signAssertion(sa: ServiceAccount, nowSeconds: number): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: sa.token_uri ?? "https://oauth2.googleapis.com/token",
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${signer.sign(sa.private_key).toString("base64url")}`;
}

async function getAccessToken(sa: ServiceAccount): Promise<string | null> {
  const now = Date.now();
  if (accessToken && accessToken.expiresAt - 60_000 > now) return accessToken.value;
  const res = await doFetch(sa.token_uri ?? "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: signAssertion(sa, Math.floor(now / 1000)),
    }).toString(),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) return null;
  accessToken = { value: json.access_token, expiresAt: now + (json.expires_in ?? 3600) * 1000 };
  return accessToken.value;
}

/** True when FCM says this token will never deliver again. */
async function isDeadToken(res: Response): Promise<boolean> {
  if (res.status === 404) return true;
  if (res.status !== 400) return false;
  try {
    const body = (await res.clone().json()) as { error?: { status?: string; details?: Array<{ errorCode?: string }> } };
    const codes = (body.error?.details ?? []).map((d) => d.errorCode);
    return codes.includes("UNREGISTERED");
  } catch {
    return false;
  }
}

/**
 * Send one message to every device the user has registered. Never throws:
 * push is a courtesy on top of the inbox, and a failed send must not fail the
 * social action that caused it.
 */
export async function sendPush(db: DB, userId: string, message: PushMessage): Promise<PushResult> {
  const sa = readServiceAccount();
  if (!sa) return "unconfigured";
  try {
    const devices = await db
      .select({ id: pushDevices.id, token: pushDevices.token, platform: pushDevices.platform })
      .from(pushDevices)
      .where(eq(pushDevices.userId, userId));
    if (devices.length === 0) return "no_device";
    const token = await getAccessToken(sa);
    if (!token) return "failed";

    let delivered = 0;
    const dead: string[] = [];
    for (const device of devices) {
      const res = await doFetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          message: {
            token: device.token,
            notification: { title: message.title, body: message.body },
            data: { deepLink: message.deepLink, category: message.category },
            android: { priority: "normal", notification: { tag: message.category } },
            apns: { payload: { aps: { sound: "default", "thread-id": message.category } } },
          },
        }),
      });
      if (res.ok) delivered++;
      else if (await isDeadToken(res)) dead.push(device.id);
    }
    if (dead.length > 0) await db.delete(pushDevices).where(inArray(pushDevices.id, dead));
    return delivered > 0 ? "sent" : dead.length === devices.length ? "no_device" : "failed";
  } catch {
    return "failed";
  }
}
