const CACHE = 'haircard-v18';
const ASSETS = ['./', './index.html', './manifest.json', './sw.js', './icon.svg'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
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
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // /api/* 永不走缓存
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(e.request));
    return;
  }

  const sameOrigin = url.origin === location.origin;
  const isAppShell = sameOrigin && (
    url.pathname === '/' ||
    url.pathname.endsWith('/') ||
    /\.(html|js|json)$/.test(url.pathname)
  );

  if (isAppShell) {
    // 网络优先：保证更新及时；失败回退缓存
    e.respondWith(
      fetch(e.request).then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return r;
      }).catch(() => caches.match(e.request).then(c => c || Response.error()))
    );
    return;
  }

  // 其他（图标等）：缓存优先
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
