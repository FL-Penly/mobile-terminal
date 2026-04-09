// Minimal service worker for PWA installability.
// No caching — this is a real-time WebSocket terminal app.
// All requests pass through to the network.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {
  // No-op: let the browser handle all requests normally.
  // This handler's existence satisfies Chrome's PWA install criteria.
});
