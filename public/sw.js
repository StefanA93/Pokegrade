// Cleanup SW v4 — clears all caches, forces a page reload via fresh network fetch,
// then self-destructs. Kept alive so browsers with the old caching SW receive
// this update and get kicked to the new bundle automatically.
// Safe to delete after 60+ days with no complaints.
self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .then(clients => Promise.all(
        clients.map(c => {
          try { return c.navigate(c.url) } catch (_) { return Promise.resolve() }
        })
      ))
      .then(() => self.registration.unregister())
  )
})

// Pure network passthrough — no caching at all.
// When navigate() above triggers a reload, this handler serves the fresh
// index.html + new JS bundle straight from Vercel, bypassing every cache.
self.addEventListener('fetch', event => {
  event.respondWith(fetch(event.request, { cache: 'no-store' }))
})
