'use strict';

const scope = new URL(self.registration.scope);
const cacheFamily = 'aircast-lite-shell:' + scope.pathname + ':';
const cacheName = cacheFamily + 'v21';
const app = new URL('index.html', scope).href;
const assets = ['aircast-rooms.js', 'aircast-diagnostics.js', 'aircast-qr.min.js', 'aircast-core.js', 'aircast-studio.js',
  'aircast-phone.js', 'aircast-output.js', 'aircast-app.js', 'aircast.css', 'aircast.webmanifest', 'aircast-icon-192.png', 'aircast-icon-512.png', 'aircast-peer.min.js']
  .map((name) => new URL(name, scope).href);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll([app, ...assets])));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith(cacheFamily) && name !== cacheName)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== scope.origin) return;

  if (request.mode === 'navigate' && (url.pathname === scope.pathname || url.pathname === new URL(app).pathname)) {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(cacheName);
          await cache.put(app, response.clone()).catch(() => {});
        }
        return response;
      } catch {
        return await caches.match(app, { cacheName }) || Response.error();
      }
    })());
    return;
  }

  if (assets.includes(url.href)) {
    event.respondWith((async () => {
      try { return await fetch(request); }
      catch { return await caches.match(request, { cacheName }) || Response.error(); }
    })());
  }
});
