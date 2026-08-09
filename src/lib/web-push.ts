/**
 * Browser-side web push: permission, subscription, and handing the result to
 * the server.
 *
 * The native app never comes through here — it has APNs/FCM via
 * `src/lib/native/push.ts`, and a WebView's service worker is not a reliable
 * push target. `webPushSupport()` says so explicitly rather than letting the
 * settings screen offer a button that silently does nothing.
 */
"use client";

import { isNativeApp } from "@/lib/native/platform";

export type WebPushSupport =
  | { supported: true }
  | { supported: false; reason: string };

export type WebPushPermission = "granted" | "denied" | "prompt" | "unsupported";

export function webPushSupport(): WebPushSupport {
  if (typeof window === "undefined") return { supported: false, reason: "Not in a browser" };
  if (isNativeApp()) {
    return {
      supported: false,
      reason: "The Whaikey app uses system notifications instead of browser push.",
    };
  }
  if (!("serviceWorker" in navigator)) {
    return { supported: false, reason: "This browser has no service worker support." };
  }
  if (!("PushManager" in window)) {
    return { supported: false, reason: "This browser does not support push notifications." };
  }
  if (!("Notification" in window)) {
    return { supported: false, reason: "This browser cannot show notifications." };
  }
  return { supported: true };
}

export function webPushPermission(): WebPushPermission {
  if (!webPushSupport().supported) return "unsupported";
  const state = Notification.permission;
  return state === "granted" ? "granted" : state === "denied" ? "denied" : "prompt";
}

/**
 * VAPID public keys travel as base64url; `applicationServerKey` wants raw
 * bytes.
 */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration("/sw.js");
  return existing ?? navigator.serviceWorker.register("/sw.js");
}

/** The endpoint this browser is currently subscribed with, if any. */
export async function currentSubscriptionEndpoint(): Promise<string | null> {
  if (!webPushSupport().supported) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration("/sw.js");
    const sub = await reg?.pushManager.getSubscription();
    return sub?.endpoint ?? null;
  } catch {
    return null;
  }
}

export type SubscribeResult =
  | { ok: true; endpoint: string }
  | { ok: false; reason: string };

/**
 * Prompt, subscribe, and register with the server.
 *
 * An existing subscription is reused rather than replaced: re-subscribing mints
 * a new endpoint and orphans the old row, which is how a settings screen ends
 * up listing the same laptop four times.
 */
export async function subscribeToWebPush(vapidPublicKey: string): Promise<SubscribeResult> {
  const support = webPushSupport();
  if (!support.supported) return { ok: false, reason: support.reason };
  if (!vapidPublicKey) {
    return { ok: false, reason: "This server has no web push key configured." };
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return {
      ok: false,
      reason:
        permission === "denied"
          ? "Notifications are blocked for this site. Allow them in your browser's site settings, then try again."
          : "Notification permission was dismissed.",
    };
  }

  try {
    const reg = await registration();
    await navigator.serviceWorker.ready;

    const existing = await reg.pushManager.getSubscription();
    const subscription =
      existing ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource,
      }));

    const json = subscription.toJSON();
    if (!json.keys?.p256dh || !json.keys?.auth) {
      return { ok: false, reason: "The browser returned a subscription without encryption keys." };
    }

    const res = await fetch("/api/notifications/web", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        endpoint: subscription.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return { ok: false, reason: body?.error ?? "Could not save the subscription." };
    }

    return { ok: true, endpoint: subscription.endpoint };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "Subscription failed." };
  }
}

/** Drop the browser subscription and the server row together. */
export async function unsubscribeFromWebPush(): Promise<boolean> {
  if (!webPushSupport().supported) return false;
  try {
    const reg = await navigator.serviceWorker.getRegistration("/sw.js");
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return false;

    // Server first: a browser that unsubscribed but left its row behind shows
    // up as a healthy device that never receives anything.
    await fetch(`/api/notifications/web?endpoint=${encodeURIComponent(sub.endpoint)}`, {
      method: "DELETE",
    }).catch(() => {});
    await sub.unsubscribe();
    return true;
  } catch {
    return false;
  }
}
