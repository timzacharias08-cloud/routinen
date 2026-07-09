/* Service Worker – App-Shell offline verfügbar machen.
   Strategie: stale-while-revalidate (sofort aus Cache, im Hintergrund aktualisieren). */
const CACHE = 'topnews-shell-v4';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // News-/Kurs-Requests (Proxies, Yahoo) nie anfassen – immer frisch aus dem Netz
  if (url.origin !== self.location.origin) return;

  // App-Shell: stale-while-revalidate – Cache sofort ausliefern, Netz im Hintergrund
  e.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(req).then((cached) => {
        const network = fetch(req).then((res) => {
          if (res && res.status === 200) cache.put(req, res.clone());
          return res;
        }).catch(() => cached || cache.match('./index.html'));
        return cached || network;
      })
    )
  );
});
