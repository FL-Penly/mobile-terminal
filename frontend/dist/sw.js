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
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        try {
          const response = await fetch(event.request, {
            cache: 'no-cache',
            signal: AbortSignal.timeout(5000),
          });
          if (response.ok) {
            await cache.put(event.request, response.clone());
            return response;
          }
          return await cache.match(event.request) || response;
        } catch {
          return await cache.match(event.request)
            || await cache.match('/')
            || new Response('Offline', { status: 503 });
        }
      })
    );
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
