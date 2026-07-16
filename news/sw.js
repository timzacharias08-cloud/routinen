/* Service Worker – App-Shell offline verfügbar machen.
   Strategie: network-first. Die Shell ist klein (~60 KB); Aktualität schlägt hier die
   Millisekunden aus dem Cache. Verhindert, dass nach einem Update die alte Version
   ausgeliefert wird (dafür musste man die App sonst zweimal öffnen). */
const CACHE = 'topnews-shell-v5';
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

  // App-Shell: network-first – immer die aktuelle Version, Cache nur als Offline-Fallback
  e.respondWith(
    fetch(req).then((res) => {
      if (res && res.status === 200) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() =>
      caches.match(req).then((hit) => hit || caches.match('./index.html'))
    )
  );
});
