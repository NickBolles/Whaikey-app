import { createSign } from "node:crypto";
import { connect } from "node:http2";
import { eq, inArray } from "drizzle-orm";
import type { DB } from "@/db";
import { pushDevices } from "@/db/schema";

/**
 * Push transport (whiskey-build-tracks Track D4's contract, shipped by the
 * social track so notifications have a real sender). No SDKs, no paid
 * service — JWTs are signed with node:crypto.
 *
 * - **Android → FCM HTTP v1**, configured by `FCM_SERVICE_ACCOUNT_JSON` (the
 *   service-account key file's JSON). Capacitor hands Android an FCM token.
 * - **iOS → APNs directly** over HTTP/2 with a token-based (.p8) key:
 *   `APNS_KEY_P8`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_TOPIC` (the bundle id)
 *   and optional `APNS_ENV=sandbox`. Capacitor hands iOS a raw APNs device
 *   token, which FCM cannot address without the Firebase iOS SDK.
 *
 * Either half may be unset; a device whose platform has no transport is
 * skipped, and with neither the whole thing is inbox-only. Tokens a service
 * reports as gone (FCM `UNREGISTERED`/404, APNs 410 or `BadDeviceToken`) are
 * pruned.
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

interface ApnsConfig {
  key: string;
  keyId: string;
  teamId: string;
  topic: string;
  host: string;
}

export function readApnsConfig(env: Record<string, string | undefined> = process.env): ApnsConfig | null {
  const { APNS_KEY_P8, APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC } = env;
  if (!APNS_KEY_P8 || !APNS_KEY_ID || !APNS_TEAM_ID || !APNS_TOPIC) return null;
  return {
    key: APNS_KEY_P8.replace(/\\n/g, "\n"),
    keyId: APNS_KEY_ID,
    teamId: APNS_TEAM_ID,
    topic: APNS_TOPIC,
    host: env.APNS_ENV === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com",
  };
}

export function isPushConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return readServiceAccount(env) !== null || readApnsConfig(env) !== null;
}

/** ES256 provider token for APNs (valid up to an hour; cached 50 minutes). */
export function signApnsToken(cfg: Pick<ApnsConfig, "key" | "keyId" | "teamId">, nowSeconds: number): string {
  const header = b64url(JSON.stringify({ alg: "ES256", kid: cfg.keyId }));
  const claims = b64url(JSON.stringify({ iss: cfg.teamId, iat: nowSeconds }));
  const signer = createSign("SHA256");
  signer.update(`${header}.${claims}`);
  const sig = signer.sign({ key: cfg.key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${header}.${claims}.${sig}`;
}

export interface ApnsResponse {
  status: number;
  reason?: string;
}
type ApnsTransport = (host: string, path: string, headers: Record<string, string>, body: string) => Promise<ApnsResponse>;

const http2Transport: ApnsTransport = (host, path, headers, body) =>
  new Promise((resolve, reject) => {
    const client = connect(host);
    client.on("error", reject);
    const req = client.request({ ":method": "POST", ":path": path, ...headers });
    let status = 0;
    let data = "";
    req.on("response", (h) => {
      status = Number(h[":status"] ?? 0);
    });
    req.setEncoding("utf8");
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      client.close();
      let reason: string | undefined;
      try {
        reason = data ? (JSON.parse(data) as { reason?: string }).reason : undefined;
      } catch {
        reason = undefined;
      }
      resolve({ status, reason });
    });
    req.on("error", (err) => {
      client.close();
      reject(err);
    });
    req.end(body);
  });

let apnsTransport: ApnsTransport = http2Transport;
let apnsToken: { value: string; issuedAt: number } | null = null;

export function setApnsTransportForTests(t: ApnsTransport | null): void {
  apnsTransport = t ?? http2Transport;
  apnsToken = null;
}

async function sendApns(cfg: ApnsConfig, token: string, message: PushMessage): Promise<"sent" | "dead" | "failed"> {
  const now = Math.floor(Date.now() / 1000);
  if (!apnsToken || now - apnsToken.issuedAt > 50 * 60) apnsToken = { value: signApnsToken(cfg, now), issuedAt: now };
  const res = await apnsTransport(
    cfg.host,
    `/3/device/${token}`,
    {
      authorization: `bearer ${apnsToken.value}`,
      "apns-topic": cfg.topic,
      "apns-push-type": "alert",
      "apns-priority": "5",
      "content-type": "application/json",
    },
    JSON.stringify({
      aps: { alert: { title: message.title, body: message.body }, sound: "default", "thread-id": message.category },
      deepLink: message.deepLink,
      category: message.category,
    }),
  );
  if (res.status === 200) return "sent";
  if (res.status === 410 || res.reason === "BadDeviceToken" || res.reason === "Unregistered") return "dead";
  return "failed";
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
  const apns = readApnsConfig();
  if (!sa && !apns) return "unconfigured";
  try {
    const all = await db
      .select({ id: pushDevices.id, token: pushDevices.token, platform: pushDevices.platform })
      .from(pushDevices)
      .where(eq(pushDevices.userId, userId));
    const devices = all.filter((d) => (d.platform === "ios" ? apns : sa));
    if (devices.length === 0) return "no_device";

    let delivered = 0;
    const dead: string[] = [];
    let fcmToken: string | null | undefined;
    for (const device of devices) {
      if (device.platform === "ios" && apns) {
        const outcome = await sendApns(apns, device.token, message).catch(() => "failed" as const);
        if (outcome === "sent") delivered++;
        else if (outcome === "dead") dead.push(device.id);
        continue;
      }
      if (!sa) continue;
      if (fcmToken === undefined) fcmToken = await getAccessToken(sa);
      if (!fcmToken) continue;
      const res = await doFetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
        method: "POST",
        headers: { authorization: `Bearer ${fcmToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          message: {
            token: device.token,
            notification: { title: message.title, body: message.body },
            data: { deepLink: message.deepLink, category: message.category },
            android: { priority: "normal", notification: { tag: message.category } },
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
