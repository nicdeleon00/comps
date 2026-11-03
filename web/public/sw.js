// Comps service worker: shows drop alerts sent by the monitor on your PC,
// and opens the product page when you tap one.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : '' }; }
  const scope = self.registration.scope;
  event.waitUntil(self.registration.showNotification(data.title || 'Comps', {
    body: data.body || '',
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
    icon: scope + 'apple-touch-icon.png',
    badge: scope + 'apple-touch-icon.png',
    data: { url: data.url || 'drops' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || 'drops';
  const target = /^https?:/.test(url) ? url : self.registration.scope + url.replace(/^\//, '');
  event.waitUntil(self.clients.openWindow(target));
});
