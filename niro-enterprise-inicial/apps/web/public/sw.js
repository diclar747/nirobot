// Only public offline assets are cached. API, messages, uploads and auth stay network-only.
const CACHE = 'niro-public-v1';
const OFFLINE_ASSETS = ['/offline.html', '/icons/niro-192.png'];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(OFFLINE_ASSETS)));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('niro-public-') && key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
// Updates activate only after the agent explicitly chooses to reload.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'NIRO_ACTIVATE_UPDATE') self.skipWaiting();
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (OFFLINE_ASSETS.includes(url.pathname) && !url.search) {
    event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
    return;
  }
  if (event.request.mode === 'navigate' && !/^\/(api|socket\.io|uploads)(\/|$)/.test(url.pathname)) {
    event.respondWith(fetch(event.request).catch(() => caches.match('/offline.html')));
  }
});

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'NIRO', body: event.data.text() };
  }

  const title = payload.title || 'NIRO';
  const options = {
    body: payload.body || '',
    icon: '/icons/niro-192.png',
    badge: '/icons/badge-96.png',
    tag: payload.tag || undefined,
    data: { url: payload.url || '/' }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Si ya hay una pestaña de la app abierta, la enfoca y navega ahí adentro; si no, abre una nueva.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const candidate = new URL(event.notification.data?.url || '/inbox', self.location.origin);
  const targetUrl = candidate.origin === self.location.origin ? candidate.pathname + candidate.search : '/inbox';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          client.postMessage({ type: 'niro-push-navigate', url: targetUrl });
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
