// Cleanup SW: evicts all caches, claims clients, then self-destructs.
// Kept alive so browsers with the old caching SW can receive this update.
// Safe to delete after 60+ days with no cache complaints.
self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.registration.unregister())
  )
})

// Pure network passthrough — no caching, no interception side-effects.
self.addEventListener('fetch', event => {
  event.respondWith(fetch(event.request, { cache: 'no-store' }))
})
