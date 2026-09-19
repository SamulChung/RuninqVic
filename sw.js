/* RuninqVic service worker: caches the app shell so it opens offline and installs to the home screen.
   Bump CACHE whenever files change (the app also checks for updates on every load). */
const CACHE = 'runinqvic-v1.6.3';
const SHELL = [
  './', './index.html', './manual.html', './manifest.json',
  './css/app.css',
  './js/state.js', './js/timeline.js', './js/designs.js', './js/render.js', './js/audio.js', './js/exporter.js', './js/store.js', './js/musicgen.js', './js/app.js',
  './lib/mp4-muxer.min.js', './lib/webm-muxer.min.js',
  './assets/icon-192.png', './assets/icon-512.png', './assets/icon-512-maskable.png', './assets/apple-touch-icon.png', './assets/logo.svg', './assets/tenai-logo.png', './assets/tenai-logo-dark.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
/* network first (so deploys show up), cache as fallback (offline) */
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || !e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' }).then((res) => { /* always revalidate so a new deploy is picked up at once */
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || (e.request.mode === 'navigate' ? caches.match('./index.html') : undefined)))
  );
});
