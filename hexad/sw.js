// hexad remote: the service worker of one pairing (registered with scope ./p/<device id>/, so each paired hexad has
// its own push subscription). It shows hexad's pushes as notifications, hands them to any open page, and keeps the
// latest of each kind so a page opened later (from a notification, say) can show it.
const LAST = 'hexad-last';

const SHARES = 'hexad-share';
const APP = new URL('./', self.location).href;

self.addEventListener('install', () => self.skipWaiting());

// The phone's share sheet posts what was shared to ./share (the manifest's share target). Only the app-wide worker
// (scope ./) sees it: the per-pairing workers' scopes are narrower. It keeps the share and opens the page, which asks
// where it goes.
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'POST' || new URL(req.url).href.split('?')[0] !== APP + 'share') return;
  event.respondWith((async () => {
    const form = await req.formData();
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const cache = await caches.open(SHARES);
    const files = [];
    for (const f of form.getAll('files')) {
      if (!(f instanceof File) || !f.size) continue;
      const n = files.length;
      await cache.put(new Request(APP + 'share/' + id + '/' + n), new Response(f, { headers: { 'content-type': f.type || 'application/octet-stream' } }));
      files.push({ n, name: f.name, type: f.type, size: f.size });
    }
    const meta = { title: String(form.get('title') || ''), text: String(form.get('text') || ''), url: String(form.get('url') || ''), files, at: Date.now() };
    await cache.put(new Request(APP + 'share/' + id), new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } }));
    return Response.redirect(APP + '?share=' + id, 303);
  })());
});
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
  // A link to hexad's tunnel opens inside the app, which frames it; anything else (a status, a device code) opens the app.
  const app = new URL('../../', self.registration.scope).href;
  const target = msg.t === 'code' ? app + '#code'
    : msg.url && /^https:\/\/[a-z0-9.-]+\.devtunnels\.ms\//.test(msg.url) ? app + '#frame=' + encodeURIComponent(msg.url)
    : msg.url || app;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // The app already open: bring it forward and have it show the link, rather than opening a second window.
    const open = wins.find(w => w.url.startsWith(app));
    if (open && target.startsWith(app + '#frame=')) { await open.focus(); new BroadcastChannel('hexad').postMessage({ t: 'frame', url: msg.url, device: msg.device }); return; }
    const same = wins.find(w => w.url === target);
    if (same) return same.focus();
    return self.clients.openWindow(target);
  })());
});
