import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'

if (!import.meta.env.VITE_SUPABASE_URL || !import.meta.env.VITE_SUPABASE_ANON_KEY) {
  document.body.innerHTML = '<div style="color:#e74c3c;font-family:sans-serif;padding:32px">Konfigurationsfejl: VITE_SUPABASE_URL og VITE_SUPABASE_ANON_KEY er ikke sat.</div>'
  throw new Error('Manglende Supabase env vars')
}

async function evictStaleSW() {
  if (!('serviceWorker' in navigator)) return false
  const [registrations, cacheKeys] = await Promise.all([
    navigator.serviceWorker.getRegistrations(),
    caches.keys(),
  ])
  if (registrations.length === 0 && cacheKeys.length === 0) return false
  await Promise.all([
    ...registrations.map(r => r.unregister()),
    ...cacheKeys.map(k => caches.delete(k)),
  ])
  return true
}

const CLEANUP_FLAG = 'sw_cleanup_done'
if (sessionStorage.getItem(CLEANUP_FLAG) !== '1') {
  evictStaleSW().then(didCleanup => {
    if (didCleanup) {
      sessionStorage.setItem(CLEANUP_FLAG, '1')
      window.location.reload()
    }
  })
} else {
  sessionStorage.removeItem(CLEANUP_FLAG)
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
