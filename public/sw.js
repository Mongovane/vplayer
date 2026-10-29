/**
 * sw.js
 *
 * The old worker precached index.html and every css/js file under a manual
 * CACHE_NAME. Its own docs told contributors to bump that constant by hand and
 * tick "Update on reload" in devtools, which is a bug wearing a workaround.
 *
 * This one never serves a cached HTML document:
 *   - navigations are network-first (cache: 'no-store'), falling back to cache only when offline
 *   - code assets (css, js) are network-first (cache: 'no-store'): stale-while-revalidate leaves the
 *     running app one deploy behind, and default HTTP cache mode can serve stale ES modules.
 *   - images and icons stay stale-while-revalidate; they rarely change and
 *     painting them instantly is worth more than freshness.
 *   - /api/* is never cached; audio and images are left to the HTTP cache,
 *     because Range requests and a Cache Storage entry do not mix
 */

const CACHE = 'vplayer-runtime-v149';
const COVER_CACHE = 'vplayer-covers-v1';
const SHELL = [
  '/',
  '/index.html',
  '/styles/vane.css',
  '/manifest.webmanifest',
  '/img/vane.svg',
  '/img/vane-maskable.svg',
  '/img/vane-180.png',
  '/img/vane-192.png',
  '/img/vane-512.png',
  '/img/vane-maskable-512.png',
  '/src/main.js',
  '/src/store.js',
  '/src/api.js',
  '/src/engine.js',
  '/src/dial.js',
  '/src/list.js',
  '/src/lyrics.js',
  '/src/offline.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) =>
        Promise.all(
          SHELL.map((u) =>
            fetch(u, { cache: 'reload' }).then((res) => (res.ok ? c.put(u, res) : null))
          )
        )
      )
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith('vplayer-runtime-') && n !== CACHE).map((n) => caches.delete(n)));
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
    const fresh = await fetch(event.request, { cache: 'no-store' });
    const cache = await caches.open(CACHE);
    cache.put('/index.html', fresh.clone());
    return fresh;
  } catch {
    const cache = await caches.open(CACHE);
    return (await cache.match('/index.html')) || Response.error();
  }
}

/**
 * Fresh if the network answers (bypassing HTTP disk cache), cached if it does not.
 * Used for css and js so a deploy takes effect immediately on reload.
 */
async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(request, { cache: 'no-store' });
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch {
    const hit = (await cache.match(request)) || (await cache.match(request, { ignoreSearch: true }));
    return hit || Response.error();
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

  // Cache immutable album covers locally in Cache Storage (keyed without token)
  // so Dial, Lock Screen, and list covers load in 0ms and survive offline.
  if (url.pathname === '/api/image') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(COVER_CACHE);
        const keyUrl = new URL(url.href);
        keyUrl.searchParams.delete('token');
        const cacheKey = keyUrl.toString();
        const hit = await cache.match(cacheKey);
        if (hit) return hit;
        try {
          const res = await fetch(request);
          if (res.ok) cache.put(cacheKey, res.clone());
          return res;
        } catch {
          return caches.match('/img/vane-512.png') || Response.error();
        }
      })()
    );
    return;
  }

  // Never intercept other API routes. Audio relays use Range; interception breaks seeking.
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(event));
    return;
  }

  if (/\.(css|js)$/.test(url.pathname)) {
    event.respondWith(networkFirst(request));
    return;
  }

  if (/\.(svg|woff2?|png|webmanifest)$/.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
