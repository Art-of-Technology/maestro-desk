// Respovia service worker — Web Push for offline-agent notifications.
// Served at /sw.js (scope '/'). It only handles push display + click; it is
// deliberately not a caching/offline SW (the SPA isn't a PWA).

// Take control on first install so push works without a reload.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = {}; }
  const title = data.title || 'Respovia';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    tag:  data.tag || undefined,        // same tag → newer push replaces older
    data: { url: data.url || '/' },
    renotify: Boolean(data.tag),
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Focus an existing desk tab if one's open; otherwise open a new one.
    for (const c of wins) {
      if ('focus' in c) {
        await c.focus();
        if (url && 'navigate' in c) { try { await c.navigate(url); } catch (_) { /* cross-origin / not allowed */ } }
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(url);
  })());
});
