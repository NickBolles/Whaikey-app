/*
 * Whaikey service worker — web push only.
 *
 * Deliberately does not cache anything. The native shell loads the deployed
 * site over HTTPS (docs/NATIVE_APP.md §2), and offline pour logging is already
 * handled in the app by src/lib/native/offline-queue.ts; adding a second,
 * invisible caching layer here would mean two sources of truth for what the
 * user is looking at. This file exists so the browser has somewhere to deliver
 * a push event, and nothing else.
 */

self.addEventListener("install", () => {
  // Take over immediately: a user who just clicked "turn on notifications"
  // should not have to close every tab before the first one can arrive.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  // A push with no readable payload still has to show *something*: browsers
  // revoke the push permission of a site that receives a push and shows no
  // notification, so a malformed payload must not cost the user their setup.
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  const title = payload.title || "Whaikey";
  const options = {
    body: payload.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    // Collapse repeats of the same category rather than stacking five price
    // alerts on a lock screen.
    tag: payload.category || "whaikey",
    renotify: false,
    data: { url: payload.url || "/" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      // Focus an existing tab if the app is already open — opening a second
      // copy of a single-page app is the wrong answer to a tapped notification.
      for (const client of clients) {
        if (client.url.includes(target) && "focus" in client) return client.focus();
      }
      const existing = clients.find((client) => "focus" in client);
      if (existing) {
        existing.navigate(target);
        return existing.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});
