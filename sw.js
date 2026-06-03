const CACHE = 'haircard-v9';
const ASSETS = ['./', './index.html', './manifest.json', './sw.js', './icon.svg'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS))
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // cache-first: 离线优先读缓存
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
