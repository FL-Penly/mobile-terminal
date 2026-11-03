const CACHE_NAME = 'vibeterm-v2';
const PRECACHE = ['/', '/manifest.json', '/icon.svg', '/icon-maskable.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k.startsWith('vibeterm-') && k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return;

  // The entire app is bundled into HTML. Always revalidate navigations so a
  // refresh runs the current code instead of serving yesterday's application.
  if (event.request.mode === 'navigate') {
    const cachePromise = caches.open(CACHE_NAME).catch(() => null);
    let cacheWrite = Promise.resolve();
    const responsePromise = (async () => {
      // Limit waiting for headers, but never abort a body already handed to
      // the browser: after streaming starts we cannot swap in an offline page.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(event.request, {
          cache: 'no-cache',
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (response.ok) {
          const copy = response.clone();
          cacheWrite = cachePromise.then(cache => cache?.put(event.request, copy)).catch(() => {});
          return response;
        }
        const cache = await cachePromise;
        return await cache?.match(event.request).catch(() => undefined) || response;
      } catch {
        const cache = await cachePromise;
        return await cache?.match(event.request).catch(() => undefined)
          || await cache?.match('/').catch(() => undefined)
          || new Response('Offline', { status: 503 });
      } finally {
        clearTimeout(timer);
      }
    })();
    event.respondWith(responsePromise);
    // Register synchronously to keep the worker alive for the background write.
    event.waitUntil(responsePromise.then(() => cacheWrite).catch(() => {}));
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(event.request);
      const fetchPromise = fetch(event.request)
        .then(res => { if (res.ok) cache.put(event.request, res.clone()); return res; })
        .catch(() => null);
      return cached || await fetchPromise || new Response('Offline', { status: 503 });
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
