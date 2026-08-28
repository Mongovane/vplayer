/**
 * sw.js
 *
 * The old worker precached index.html and every css/js file under a manual
 * CACHE_NAME. Its own docs told contributors to bump that constant by hand and
 * tick "Update on reload" in devtools, which is a bug wearing a workaround.
 *
 * This one never serves a cached HTML document:
 *   - navigations are network-first, falling back to cache only when offline
 *   - static assets are stale-while-revalidate, so a stale copy paints
 *     immediately and the fresh copy lands for the next load
 *   - /api/* is never cached; audio and images are left to the HTTP cache,
 *     because Range requests and a Cache Storage entry do not mix
 */

const CACHE = 'vplayer-runtime';
const SHELL = ['/', '/index.html', '/styles/vane.css', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
      await self.clients.claim();
    })()
  );
});

/** Fresh document if the network answers, cached shell if it does not. */
async function handleNavigation(event) {
  try {
    const preloaded = await event.preloadResponse;
    if (preloaded) return preloaded;
    const fresh = await fetch(event.request);
    const cache = await caches.open(CACHE);
    cache.put('/index.html', fresh.clone());
    return fresh;
  } catch {
    const cache = await caches.open(CACHE);
    return (await cache.match('/index.html')) || Response.error();
  }
}

/** Paint from cache, refresh in the background. */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);

  const network = fetch(request)
    .then((res) => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);

  if (hit) return hit;
  const res = await network;
  return res || Response.error();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  // Never intercept the API. Audio relays use Range; interception breaks seeking.
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(event));
    return;
  }

  if (/\.(css|js|svg|woff2?|png|webmanifest)$/.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
