/**
 * The transport seam.
 *
 * Everything above this file decides *whether* to send; this file is the only
 * place that knows *how*. It mirrors `src/lib/ai/client.ts`: one getter, one
 * test setter, so route and pipeline tests never touch a push service and a
 * transport can be swapped without reaching into the routing logic.
 *
 * Two transports, one interface. Web is RFC 8291 push through `web-push`;
 * native is FCM HTTP v1, which covers Android directly and iOS through APNs
 * (docs/NATIVE_APP.md §5).
 */
import { createSign } from "node:crypto";
import type { PushDevice } from "@/db/schema";
import { getFcmConfig, getVapidConfig } from "./config";

export interface PushMessage {
  title: string;
  body: string;
  /** Deep link opened when the notification is tapped. */
  url?: string;
  category: string;
}

export interface SendResult {
  ok: boolean;
  /** Provider-supplied reason, short enough to show in the delivery log. */
  error?: string;
  /**
   * The registration is permanently gone (404/410, FCM `UNREGISTERED`). The
   * caller marks the device revoked rather than retrying forever — and, more
   * importantly, the settings screen can then say so instead of showing a
   * device that looks fine and receives nothing.
   */
  gone?: boolean;
  /** No credentials for this transport; not the device's fault. */
  notConfigured?: boolean;
}

export interface PushSender {
  send(device: PushDevice, message: PushMessage): Promise<SendResult>;
}

// ---------------------------------------------------------------------------
// Web push
// ---------------------------------------------------------------------------

async function sendWeb(device: PushDevice, message: PushMessage): Promise<SendResult> {
  const vapid = getVapidConfig();
  if (!vapid) return { ok: false, notConfigured: true, error: "Web push keys are not configured" };
  if (!device.p256dh || !device.authSecret) {
    return { ok: false, gone: true, error: "Subscription is missing its encryption keys" };
  }

  // Imported lazily so the library (and its crypto deps) stay out of any bundle
  // that merely reads notification settings.
  const webpush = (await import("web-push")).default;
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);

  try {
    await webpush.sendNotification(
      {
        endpoint: device.token,
        keys: { p256dh: device.p256dh, auth: device.authSecret },
      },
      JSON.stringify({
        title: message.title,
        body: message.body,
        url: message.url ?? "/",
        category: message.category,
      }),
      { TTL: 60 * 60 * 12 },
    );
    return { ok: true };
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    // 404/410 is the push service telling us the subscription is dead. Anything
    // else (429, 5xx, network) is transient and the device stays registered.
    if (status === 404 || status === 410) {
      return { ok: false, gone: true, error: "Subscription expired or was revoked" };
    }
    return { ok: false, error: describeError(err, status) };
  }
}

// ---------------------------------------------------------------------------
// Native push (FCM HTTP v1)
// ---------------------------------------------------------------------------

let cachedToken: { value: string; expiresAt: number } | null = null;

/** Test-only: drop the cached FCM access token. */
export function resetFcmTokenCache(): void {
  cachedToken = null;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Mint (and cache) a Google OAuth access token from the service-account key.
 *
 * Cached a minute short of expiry: tokens last an hour, and re-signing a JWT on
 * every notification would dominate the cost of sending one.
 */
async function fcmAccessToken(): Promise<string | null> {
  const config = getFcmConfig();
  if (!config) return null;
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) return cachedToken.value;

  const claims = {
    iss: config.clientEmail,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(
    JSON.stringify(claims),
  )}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  const jwt = `${unsigned}.${base64url(signer.sign(config.privateKey))}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) return null;

  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) return null;
  cachedToken = { value: json.access_token, expiresAt: now + (json.expires_in ?? 3600) };
  return cachedToken.value;
}

async function sendNative(device: PushDevice, message: PushMessage): Promise<SendResult> {
  const config = getFcmConfig();
  if (!config) {
    return { ok: false, notConfigured: true, error: "Firebase credentials are not configured" };
  }

  const accessToken = await fcmAccessToken();
  if (!accessToken) return { ok: false, error: "Could not authenticate with Firebase" };

  try {
    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${config.projectId}/messages:send`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          message: {
            token: device.token,
            notification: { title: message.title, body: message.body },
            data: { url: message.url ?? "/", category: message.category },
            apns: { payload: { aps: { sound: "default" } } },
          },
        }),
      },
    );

    if (res.ok) return { ok: true };

    const body = (await res.json().catch(() => null)) as
      | { error?: { status?: string; message?: string } }
      | null;
    const status = body?.error?.status;
    if (res.status === 404 || status === "UNREGISTERED" || status === "NOT_FOUND") {
      return { ok: false, gone: true, error: "The app was uninstalled or its token expired" };
    }
    return { ok: false, error: body?.error?.message ?? `Firebase returned ${res.status}` };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

function describeError(err: unknown, status?: number): string {
  const base = err instanceof Error ? err.message : String(err);
  return status ? `${base} (HTTP ${status})` : base;
}

// ---------------------------------------------------------------------------
// Seam
// ---------------------------------------------------------------------------

const defaultSender: PushSender = {
  send(device, message) {
    return device.platform === "web" ? sendWeb(device, message) : sendNative(device, message);
  },
};

let sender: PushSender = defaultSender;

export function getPushSender(): PushSender {
  return sender;
}

/** Test-only: swap the transport (mirrors `setAnthropicForTests`). */
export function setPushSenderForTests(next: PushSender | null): void {
  sender = next ?? defaultSender;
}
