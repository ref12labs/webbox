// hexad remote: the service worker of one pairing (registered with scope ./p/<device id>/, so each paired hexad has
// its own push subscription). It shows hexad's pushes as notifications, hands them to any open page, and keeps the
// latest of each kind so a page opened later (from a notification, say) can show it.
const LAST = 'hexad-last';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let msg;
  try { msg = event.data ? event.data.json() : null; } catch { msg = null; }
  if (!msg) msg = { t: 'unknown', title: 'hexad', body: event.data ? event.data.text() : '' };
  const device = new URL(self.registration.scope).pathname.split('/').filter(Boolean).pop();
  msg.device = device;
  event.waitUntil((async () => {
    new BroadcastChannel('hexad').postMessage(msg);
    const cache = await caches.open(LAST);
    await cache.put(new Request('last/' + device + '/' + msg.t), new Response(JSON.stringify(msg), { headers: { 'content-type': 'application/json' } }));
    await self.registration.showNotification(msg.title || 'hexad', {
      body: msg.body || '',
      tag: msg.tag || msg.t,
      renotify: true,
      requireInteraction: msg.t === 'code',
      icon: new URL('../../icon-192.png', self.registration.scope).href,
      badge: new URL('../../icon-192.png', self.registration.scope).href,
      data: msg,
    });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const msg = event.notification.data || {};
  // A link goes where it says; anything else (a status, a device code) opens the page, which shows it.
  const target = msg.t === 'code' ? new URL('../../#code', self.registration.scope).href
    : msg.url || new URL('../../', self.registration.scope).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const same = wins.find(w => w.url === target);
    if (same) return same.focus();
    return self.clients.openWindow(target);
  })());
});
