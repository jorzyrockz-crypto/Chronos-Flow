const CACHE_NAME = 'chronos-flow-5.10-v104';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/chronos.svg',
  './icons/chronos-192.png',
  './icons/chronos-512.png',
  './icons/apple-touch-icon.png',
  './icons/flow-logo-dark.png',
  './icons/flow-logo-light.png',
  './icons/flow-logo-dark-sm.png',
  './icons/flow-logo-light-sm.png',
  './icons/chronos-banner-opt.jpg'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
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
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const isHtml = req.mode === 'navigate' ||
                 url.pathname.endsWith('/') ||
                 url.pathname.endsWith('/index.html') ||
                 url.pathname === '';

  if (isHtml) {
    // Network-First for HTML/navigation so code updates are received immediately
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then(cached => cached || caches.match('./index.html')))
    );
    return;
  }

  // Cache-First with Network fallback for static assets
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
        }
        return res;
      });
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      for (const client of clients) {
        if (client.url === target && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
