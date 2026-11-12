const CACHE_NAME = 'chronos-flow-5.10-v189';
const APP_SHELL = [
  './',
  './index.html',
  './favicon.ico?v=187',
  './manifest.webmanifest?v=189',
  './icons/chronos.svg?v=187',
  './icons/chronos-32.png?v=187',
  './icons/chronos-48.png?v=187',
  './icons/chronos-64.png?v=187',
  './icons/chronos-128.png?v=187',
  './icons/chronos-192.png?v=187',
  './icons/chronos-256.png?v=187',
  './icons/chronos-512.png?v=187',
  './icons/chronos-maskable-512.png?v=187',
  './icons/apple-touch-icon.png?v=187',
  './icons/flow-logo-dark.png?v=187',
  './icons/flow-logo-light.png?v=187',
  './icons/flow-logo-dark-sm.png?v=187',
  './icons/flow-logo-light-sm.png?v=187',
  './icons/chronos-banner-opt.jpg?v=187',
  './icons/chronos-mobile-preview.jpg?v=189'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.all(APP_SHELL.map(url => cache.add(new Request(url, { cache: 'reload' }))))
    )
  );
  self.skipWaiting();
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key.startsWith('chronos-') && key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || req.cache === 'no-store') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.endsWith('/sw.js')) return;

  const isHtml = req.mode === 'navigate' ||
                 url.pathname.endsWith('/') ||
                 url.pathname.endsWith('/index.html') ||
                 url.pathname === '';
  const isManifest = url.pathname.endsWith('/manifest.webmanifest');

  if (isHtml || isManifest) {
    // Network-First for HTML/navigation and manifest so app & icon updates are received immediately
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
          }
          return res;
        })
        .catch(() =>
          caches.open(CACHE_NAME).then(cache =>
            cache.match(req).then(cached => cached || cache.match(isHtml ? './index.html' : './manifest.webmanifest?v=187'))
          )
        )
    );
    return;
  }

  // Cache-First with Network fallback for static assets (scoped to active CACHE_NAME)
  event.respondWith(
    caches.open(CACHE_NAME).then(cache =>
      cache.match(req).then(cached => {
        if (cached) return cached;
        return fetch(req).then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            cache.put(req, copy);
          }
          return res;
        });
      })
    )
  );
});

self.addEventListener('push', event => {
  const rawPayload = event.data ? event.data.text() : '';
  let payload = {};
  try { payload = rawPayload ? JSON.parse(rawPayload) : {}; }
  catch { payload = { body: rawPayload }; }

  const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
  const rawUrl = payload.url || data.url || './';
  let targetUrl = new URL('./', self.location.origin).href;
  try {
    const parsed = new URL(rawUrl, self.location.origin);
    if (parsed.origin === self.location.origin) targetUrl = parsed.href;
  } catch {}

  const title = String(payload.title || 'Chronos Flow').slice(0, 120);
  const body = String(payload.body || 'You have a new Chronos update.').slice(0, 300);
  const options = {
    body,
    icon: './icons/chronos-192.png?v=187',
    badge: './icons/chronos-192.png?v=187',
    tag: String(payload.tag || data.tag || 'chronos-push').slice(0, 120),
    renotify: false,
    data: { ...data, url: targetUrl }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const exact = clients.find(client => client.url === target && 'focus' in client);
      if (exact) return exact.focus();
      const anyWindow = clients.find(client => 'focus' in client);
      if (anyWindow) return anyWindow.focus();
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
