/* Service Worker – App-Shell offline verfügbar machen.
   Strategie: network-first (immer aktuell, Cache nur als Offline-Fallback). */
const CACHE = 'topnews-shell-v3';
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

  // App-Shell: network-first, Cache als Offline-Fallback
  e.respondWith(
    fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() =>
      caches.match(req).then((hit) => hit || caches.match('./index.html'))
    )
  );
});
