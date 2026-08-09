/**
 * Server-side push configuration, and an honest report of what is missing.
 *
 * Both transports need credentials the app cannot invent, and the failure mode
 * when they are absent is the worst kind: everything looks fine, the user
 * toggles notifications on, and nothing ever arrives. So configuration state is
 * a first-class thing the settings screen reads and shows, not an env var that
 * quietly decides whether the feature exists.
 */

export interface TransportConfigStatus {
  configured: boolean;
  /** Env var names that would need setting. Shown to the operator, not hidden. */
  missing: string[];
}

export interface PushConfigStatus {
  web: TransportConfigStatus;
  native: TransportConfigStatus;
}

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  /** `mailto:` or https URL identifying the sender, required by RFC 8292. */
  subject: string;
}

export interface FcmConfig {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

function present(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * The VAPID key pair for web push.
 *
 * The public key is also needed in the browser to build the subscription, so it
 * is exposed as `NEXT_PUBLIC_VAPID_PUBLIC_KEY`; the private key never leaves
 * the server. Generate a pair with `npx web-push generate-vapid-keys`.
 */
export function getVapidConfig(): VapidConfig | null {
  const publicKey = present("NEXT_PUBLIC_VAPID_PUBLIC_KEY");
  const privateKey = present("WEB_PUSH_VAPID_PRIVATE_KEY");
  if (!publicKey || !privateKey) return null;
  return {
    publicKey,
    privateKey,
    subject: present("WEB_PUSH_CONTACT") ?? "mailto:hello@whaikey.app",
  };
}

/**
 * FCM HTTP v1 service-account credentials. One project covers both Android and
 * iOS (APNs is reached through FCM), which is why there is a single native
 * transport rather than one per platform — see docs/NATIVE_APP.md §5.
 */
export function getFcmConfig(): FcmConfig | null {
  const projectId = present("FCM_PROJECT_ID");
  const clientEmail = present("FCM_CLIENT_EMAIL");
  // Env vars cannot hold real newlines in most hosts, so the PEM is stored with
  // literal \n and unescaped here.
  const privateKey = present("FCM_PRIVATE_KEY")?.replace(/\\n/g, "\n");
  if (!projectId || !clientEmail || !privateKey) return null;
  return { projectId, clientEmail, privateKey };
}

export function getPushConfigStatus(): PushConfigStatus {
  const webMissing = [
    !present("NEXT_PUBLIC_VAPID_PUBLIC_KEY") && "NEXT_PUBLIC_VAPID_PUBLIC_KEY",
    !present("WEB_PUSH_VAPID_PRIVATE_KEY") && "WEB_PUSH_VAPID_PRIVATE_KEY",
  ].filter((v): v is string => typeof v === "string");

  const nativeMissing = [
    !present("FCM_PROJECT_ID") && "FCM_PROJECT_ID",
    !present("FCM_CLIENT_EMAIL") && "FCM_CLIENT_EMAIL",
    !present("FCM_PRIVATE_KEY") && "FCM_PRIVATE_KEY",
  ].filter((v): v is string => typeof v === "string");

  return {
    web: { configured: webMissing.length === 0, missing: webMissing },
    native: { configured: nativeMissing.length === 0, missing: nativeMissing },
  };
}
