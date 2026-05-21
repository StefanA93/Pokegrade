// Cleanup SW: takes control immediately, wipes all caches,
// then serves every navigation fresh from network and unregisters.
self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', event => {
  event.waitUntil(
    self.clients.claim()
      .then(() => caches.keys())
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .then(clients => clients.forEach(c => c.navigate(c.url)))
  )
})

// Intercept every navigation: serve fresh from network, then self-destruct
self.addEventListener('fetch', event => {
  if (event.request.mode === 'navigate') {
    self.registration.unregister()
    event.respondWith(fetch(event.request, { cache: 'no-store' }))
  }
})
