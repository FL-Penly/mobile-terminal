const CACHE_NAME = 'vibeterm-v3';
const NAVIGATION_FALLBACK_MS = 3000;
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

  // The entire app is bundled into HTML. Prefer the network so a refresh runs
  // current code, but over a slow link fall back to the cached copy quickly and
  // let the download finish in the background for the next open. Never abort
  // the network fetch: on a slow link that throws away a nearly finished page.
  if (event.request.mode === 'navigate') {
    const cacheKey = new Request(url.origin + url.pathname)
    const cachePromise = caches.open(CACHE_NAME).catch(() => null)
    const findCached = async () => {
      const cache = await cachePromise
      if (!cache) return undefined
      return await cache.match(cacheKey).catch(() => undefined)
        || await cache.match('/').catch(() => undefined)
    }
    const networkPromise = fetch(event.request, { cache: 'no-cache' })
    const updatePromise = networkPromise
      .then(async response => {
        if (!response.ok) return
        const copy = response.clone()
        const cache = await cachePromise
        await cache?.put(cacheKey, copy)
      })
      .catch(() => {})
    const fresh = networkPromise
      .then(async response => (response.ok ? response : (await findCached()) || response))
      .catch(async () => (await findCached()) || new Response('Offline', { status: 503 }))
    let timer
    const slowNetworkFallback = new Promise(resolve => {
      timer = setTimeout(() => {
        void findCached().then(cached => { if (cached) resolve(cached) })
      }, NAVIGATION_FALLBACK_MS)
    })
    const responsePromise = Promise.race([fresh, slowNetworkFallback])
      .finally(() => clearTimeout(timer))
    event.respondWith(responsePromise)
    // Keep the worker alive until the background cache write completes.
    event.waitUntil(responsePromise.then(() => updatePromise).catch(() => {}))
    return
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
