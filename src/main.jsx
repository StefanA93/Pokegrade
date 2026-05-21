import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'

if (!import.meta.env.VITE_SUPABASE_URL || !import.meta.env.VITE_SUPABASE_ANON_KEY) {
  document.body.innerHTML = '<div style="color:#e74c3c;font-family:sans-serif;padding:32px">Konfigurationsfejl: VITE_SUPABASE_URL og VITE_SUPABASE_ANON_KEY er ikke sat.</div>'
  throw new Error('Manglende Supabase env vars')
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
