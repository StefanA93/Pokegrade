import React, { useState, useEffect, useRef, useMemo, createContext, useContext } from 'react'
import { createClient } from '@supabase/supabase-js'

// ─── Supabase ────────────────────────────────────────────────────────────────
const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
)

// ─── Constants ───────────────────────────────────────────────────────────────
const GAMES = [
  {
    id: 'pokemon', label: 'Pokémon', emoji: '⚡', color: '#FFCB05',
    logo: (
      <svg viewBox="0 0 24 24" width="26" height="26" fill="none">
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5"/>
        <path d="M2 12a10 10 0 0 1 20 0Z" fill="currentColor" fillOpacity="0.35"/>
        <line x1="2" y1="12" x2="22" y2="12" stroke="currentColor" strokeWidth="1.5"/>
        <circle cx="12" cy="12" r="3" fill="currentColor"/>
        <circle cx="12" cy="12" r="1.4" fill="#06060a"/>
      </svg>
    ),
  },
  {
    id: 'mtg', label: 'Magic', emoji: '🔮', color: '#a29bfe',
    logo: (
      <svg viewBox="0 0 24 24" width="26" height="26" fill="none">
        <polygon points="12,2 14.5,9 22,9 16,13.5 18.5,21 12,16.5 5.5,21 8,13.5 2,9 9.5,9"
          fill="currentColor" fillOpacity="0.25" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
      </svg>
    ),
  },
  {
    id: 'yugioh', label: 'Yu-Gi-Oh!', emoji: '⚔️', color: '#fdcb6e',
    logo: (
      <svg viewBox="0 0 24 24" width="26" height="26" fill="none">
        <ellipse cx="12" cy="12" rx="10" ry="6" stroke="currentColor" strokeWidth="1.5"/>
        <circle cx="12" cy="12" r="3.5" fill="currentColor" fillOpacity="0.3" stroke="currentColor" strokeWidth="1.5"/>
        <circle cx="12" cy="12" r="1.6" fill="currentColor"/>
      </svg>
    ),
  },
  {
    id: 'onepiece', label: 'One Piece', emoji: '⚓', color: '#e17055',
    logo: (
      <svg viewBox="0 0 24 24" width="26" height="26" fill="none">
        <circle cx="12" cy="9" r="6" fill="currentColor" fillOpacity="0.2" stroke="currentColor" strokeWidth="1.5"/>
        <circle cx="9.5" cy="8.5" r="1.8" fill="currentColor"/>
        <circle cx="14.5" cy="8.5" r="1.8" fill="currentColor"/>
        <path d="M9 12h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        <path d="M5 15l-2 4M19 15l2 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
      </svg>
    ),
  },
  {
    id: 'dragonball', label: 'Dragon Ball', emoji: '🐉', color: '#f39c12',
    logo: (
      <svg viewBox="0 0 24 24" width="26" height="26" fill="none">
        <circle cx="12" cy="12" r="10" fill="currentColor" fillOpacity="0.2" stroke="currentColor" strokeWidth="1.5"/>
        <circle cx="9"  cy="9"  r="1.8" fill="currentColor"/>
        <circle cx="15" cy="9"  r="1.8" fill="currentColor"/>
        <circle cx="12" cy="15" r="1.8" fill="currentColor"/>
      </svg>
    ),
  },
  {
    id: 'lorcana', label: 'Lorcana', emoji: '✨', color: '#74b9ff',
    logo: (
      <svg viewBox="0 0 24 24" width="26" height="26" fill="none">
        <path d="M12 3C9 7 4 12 4 16a8 8 0 0 0 16 0c0-4-5-9-8-13Z"
          fill="currentColor" fillOpacity="0.25" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
        <path d="M9.5 16.5a3.5 3.5 0 0 0 2.5 1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.7"/>
      </svg>
    ),
  },
]

const STRIPE_URL = 'https://buy.stripe.com/REPLACE_WITH_YOUR_STRIPE_LINK'
const FONT_VALUE = "'Space Grotesk', system-ui, sans-serif"
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001'

const COLORS = {
  bg: '#06060a',
  card: '#0d0d14',
  border: '#1e1e28',
  gold: '#D4AF37',
  goldDark: '#B8960C',
  goldLight: '#F4D06F',
  goldGlow: '#FFE082',
  text: '#ffffff',
  muted: '#6b6b7d',
  danger: '#e74c3c',
  success: '#00b894',
}

function getRealTrend(card) {
  if (!card.value || !card.price_avg30) return null
  return ((card.value - card.price_avg30) / card.price_avg30) * 100
}

function getPsaCondition(grade) {
  if (!grade) return null
  const g = Number(grade)
  if (g === 10) return 'Gem Mint'
  if (g === 9)  return 'Mint'
  if (g === 8)  return 'Near Mint-Mint'
  if (g === 7)  return 'Near Mint'
  if (g === 6)  return 'Excellent-Mint'
  if (g === 5)  return 'Excellent'
  if (g === 4)  return 'Very Good-Excellent'
  if (g === 3)  return 'Very Good'
  if (g === 2)  return 'Good'
  return 'Poor'
}

function getPsaConditionColor(grade) {
  const g = Number(grade)
  if (g >= 9) return COLORS.success
  if (g >= 7) return COLORS.gold
  if (g >= 5) return '#e67e22'
  return COLORS.danger
}

function computePsaGrade(centering, corners, edges, surface) {
  const map = text => {
    if (!text) return null
    const t = text.toLowerCase()
    if (t.includes('perfect') || (t.includes('no ') && t.includes('issue'))) return 10
    if (t.includes('minimal') || t.includes('slight') || t.includes('minor')) return 7.5
    if (t.includes('moderate') || t.includes('some') || t.includes('visible')) return 5
    if (t.includes('heavy') || t.includes('severe') || t.includes('significant')) return 3
    return null
  }
  const scores = [centering, corners, edges, surface].map(map).filter(s => s !== null)
  if (!scores.length) return null
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length
  if (avg >= 9.5) return { grade: 10, label: 'Gem Mint' }
  if (avg >= 8) return { grade: 9, label: 'Mint' }
  if (avg >= 7) return { grade: 8, label: 'Near Mint-Mint' }
  if (avg >= 6) return { grade: 7, label: 'Near Mint' }
  if (avg >= 4.5) return { grade: 6, label: 'Excellent-Mint' }
  if (avg >= 3.5) return { grade: 5, label: 'Excellent' }
  return { grade: 4, label: 'Very Good-Excellent' }
}

// ─── Logo Component ───────────────────────────────────────────────────────────
function GradeDexLogo({ size = 'md' }) {
  const s = size === 'lg' ? 1.4 : size === 'sm' ? 0.7 : 1
  const ringSize = 100 * s
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 * s, userSelect: 'none' }}>
      {/* Ring + G + speed lines */}
      <div style={{ position: 'relative', width: ringSize + 24 * s, height: ringSize, display: 'flex', alignItems: 'center' }}>
        {/* Outer glow */}
        <div style={{
          position: 'absolute', left: 0, width: ringSize, height: ringSize,
          borderRadius: '50%',
          boxShadow: `0 0 ${30 * s}px ${COLORS.gold}44, 0 0 ${60 * s}px ${COLORS.gold}18`,
          pointerEvents: 'none',
        }} />
        {/* Ring circle */}
        <div style={{
          width: ringSize, height: ringSize, borderRadius: '50%', flexShrink: 0,
          border: `${4 * s}px solid ${COLORS.gold}`,
          boxShadow: `inset 0 0 ${20 * s}px ${COLORS.goldDark}33`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: `radial-gradient(circle at 35% 35%, ${COLORS.goldDark}22, transparent 60%)`,
          position: 'relative',
        }}>
          {/* Shiny arc segment — top-right gap (speed effect) */}
          <div style={{
            position: 'absolute', inset: -4 * s, borderRadius: '50%',
            border: `${4 * s}px solid transparent`,
            borderTopColor: COLORS.goldLight,
            borderRightColor: COLORS.goldLight,
            transform: 'rotate(30deg)',
          }} />
          {/* G letter */}
          <span style={{
            fontSize: 44 * s, fontWeight: 900, color: '#fff',
            lineHeight: 1, letterSpacing: -1,
            textShadow: `0 0 ${20 * s}px rgba(255,255,255,0.3)`,
          }}>G</span>
        </div>
        {/* Speed lines */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 * s, marginLeft: 6 * s }}>
          {[[20, 1], [14, 0.7], [9, 0.4]].map(([w, op], i) => (
            <div key={i} style={{
              width: w * s, height: 2.5 * s, borderRadius: 2,
              background: `linear-gradient(to right, ${COLORS.gold}, transparent)`,
              opacity: op,
            }} />
          ))}
        </div>
      </div>

      {/* Wordmark */}
      <div style={{ display: 'flex', alignItems: 'baseline' }}>
        <span style={{ fontSize: 30 * s, fontWeight: 900, color: '#fff', letterSpacing: -0.5, lineHeight: 1 }}>Grade</span>
        <span style={{ fontSize: 30 * s, fontWeight: 900, color: COLORS.gold, letterSpacing: -0.5, lineHeight: 1, textShadow: `0 0 20px ${COLORS.gold}60` }}>Dex</span>
      </div>

      {/* Tagline */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 * s }}>
        {['SCAN', 'GRADE', 'TRACK', 'COLLECT'].map((word, i, arr) => (
          <React.Fragment key={word}>
            <span style={{ fontSize: 9 * s, fontWeight: 700, color: COLORS.muted, letterSpacing: 1.5 }}>{word}</span>
            {i < arr.length - 1 && <span style={{ color: COLORS.gold, fontSize: 8 * s }}>•</span>}
          </React.Fragment>
        ))}
      </div>
    </div>
  )
}

// ─── Auth Context ─────────────────────────────────────────────────────────────
const AuthCtx = createContext(null)
const useAuth = () => useContext(AuthCtx)

// ─── Helpers ──────────────────────────────────────────────────────────────────
function compressImage(file, maxWidth = 1024, quality = 0.82) {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      const img = new Image()
      img.onload = () => {
        const canvas = document.createElement('canvas')
        const ratio = Math.min(maxWidth / img.width, maxWidth / img.height, 1)
        canvas.width = img.width * ratio
        canvas.height = img.height * ratio
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
        resolve(canvas.toDataURL('image/jpeg', quality))
      }
      img.src = e.target.result
    }
    reader.readAsDataURL(file)
  })
}

function formatEur(val) {
  if (!val && val !== 0) return '—'
  return new Intl.NumberFormat('da-DK', { style: 'currency', currency: 'EUR' }).format(val)
}

function formatCurrency(val, currency) {
  if (!val && val !== 0) return '—'
  const converted = val * (EXCHANGE_RATES[currency] ?? 1)
  return new Intl.NumberFormat('da-DK', { style: 'currency', currency, maximumFractionDigits: 2 }).format(converted)
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const globalStyle = `
  * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
  html, body, #root { height: 100%; width: 100%; }
  body {
    background: linear-gradient(160deg, #06060a 0%, #090910 100%);
    color: ${COLORS.text};
    font-family: 'DM Sans', system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
    overscroll-behavior: none;
  }
  :root {
    --gold: ${COLORS.gold};
    --gold-dark: ${COLORS.goldDark};
    --gold-light: ${COLORS.goldLight};
  }
  @keyframes goldShimmer { 0%,100% { opacity:0.6; } 50% { opacity:1; } }
  .luxury-label { font-size: 10px; font-weight: 700; letter-spacing: 1.8px; text-transform: uppercase; color: #6b6b7d; }
  button { cursor: pointer; border: none; background: none; color: inherit; font-family: inherit; }
  input, textarea { font-family: inherit; }
  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: ${COLORS.border}; border-radius: 4px; }
  @keyframes fadeIn { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:none; } }
  @keyframes fadeOut { from { opacity:1; } to { opacity:0; } }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes slideUp { from { opacity:0; transform:translateY(30px); } to { opacity:1; transform:none; } }
  @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:.5; } }
  @keyframes gradeReveal { from { opacity:0; transform:scale(.6); } to { opacity:1; transform:scale(1); } }
  @keyframes shimmer { from { background-position: -200% 0; } to { background-position: 200% 0; } }
  @keyframes splashEntrance { 0% { opacity:0; transform:scale(.75); } 60% { opacity:1; transform:scale(1.04); } 100% { opacity:1; transform:scale(1); } }
  @keyframes glowPulse { 0%,100% { opacity:.4; transform:scale(1); } 50% { opacity:.8; transform:scale(1.12); } }
  @keyframes sweepBar { 0% { transform:translateX(-100%); } 100% { transform:translateX(350%); } }
  .fadeIn { animation: fadeIn .3s ease both; }
  .fadeOut { animation: fadeOut .4s ease both; }
  .slideUp { animation: slideUp .4s cubic-bezier(.34,1.56,.64,1) both; }
  .gradeReveal { animation: gradeReveal .5s cubic-bezier(.34,1.56,.64,1) both; }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; } }
`

// ─── Tiny UI components ───────────────────────────────────────────────────────
function Spinner({ size = 24, color = COLORS.gold }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      border: `3px solid ${color}33`, borderTopColor: color,
      animation: 'spin .8s linear infinite', display: 'inline-block',
    }} />
  )
}

function Btn({ children, onClick, variant = 'primary', disabled, style, small }) {
  const base = {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    borderRadius: 14, fontWeight: 700, fontSize: small ? 13 : 16,
    padding: small ? '10px 18px' : '16px 24px', width: '100%',
    transition: 'all .15s', cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  }
  const variants = {
    primary: {
      background: `linear-gradient(135deg, #F4D06F 0%, #D4AF37 50%, #B8960C 100%)`,
      color: '#060608',
      boxShadow: '0 0 20px rgba(212,175,55,0.28), 0 4px 16px rgba(0,0,0,0.5)',
      letterSpacing: 0.3,
      fontWeight: 800,
    },
    ghost: {
      background: 'transparent',
      border: '1.5px solid #1e1e28',
      color: '#ffffff',
      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
    },
    danger: { background: COLORS.danger + '22', border: `1px solid ${COLORS.danger}`, color: COLORS.danger },
  }
  return (
    <button onClick={disabled ? undefined : onClick} style={{ ...base, ...variants[variant], ...style }}>
      {children}
    </button>
  )
}

function Card({ children, style }) {
  return (
    <div style={{
      background: 'linear-gradient(145deg, #0d0d14 0%, #0a0a10 100%)',
      borderRadius: 20, padding: 20,
      border: '1px solid #1e1e28',
      boxShadow: '0 4px 24px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.03)',
      ...style
    }}>
      {children}
    </div>
  )
}

function Badge({ children, color = COLORS.gold }) {
  return (
    <span style={{
      background: color + '22', color, border: `1px solid ${color}44`,
      borderRadius: 8, padding: '3px 10px', fontSize: 12, fontWeight: 700,
    }}>
      {children}
    </span>
  )
}

// ─── Screens ──────────────────────────────────────────────────────────────────

// ONBOARDING
const SLIDES = [
  {
    emoji: '📸',
    title: 'Scan Your Card',
    desc: 'Take a photo — AI gives you a PSA grade estimate in seconds.',
    detail: 'Supports Pokémon, MTG, Yu-Gi-Oh! and more',
    accent: COLORS.gold,
  },
  {
    emoji: '💰',
    title: 'Live EUR Prices',
    desc: 'Cardmarket prices in euros, right inside the app.',
    detail: 'See if grading is worth the investment',
    accent: COLORS.success,
  },
  {
    emoji: '🗂️',
    title: 'Your Digital PC',
    desc: 'Build and track your collection across 6 TCG games.',
    detail: 'See your total portfolio value at a glance',
    accent: '#74b9ff',
  },
  {
    emoji: '🔒',
    title: 'GDPR-Safe in the EU',
    desc: 'Your data is stored in the EU. No ads. You own your data.',
    detail: 'Start free — upgrade when you\'re ready',
    accent: COLORS.gold,
    cta: true,
  },
]

function Onboarding({ onDone }) {
  const [idx, setIdx] = useState(0)
  const slide = SLIDES[idx]

  return (
    <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', background: COLORS.bg, overflow: 'hidden' }}>

      {/* Slide-indhold */}
      <div key={idx} className="slideUp" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '0 32px', textAlign: 'center' }}>
        <div style={{
          width: 110, height: 110, borderRadius: '50%',
          background: slide.accent + '18',
          border: `1.5px solid ${slide.accent}40`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 52, marginBottom: 28,
          boxShadow: `0 0 60px ${slide.accent}30, 0 4px 24px rgba(0,0,0,0.4)`,
        }}>
          {slide.emoji}
        </div>

        <h2 style={{ fontSize: 26, fontWeight: 900, letterSpacing: -0.5, marginBottom: 12, lineHeight: 1.2, color: COLORS.text }}>
          {slide.title}
        </h2>
        <p style={{ color: COLORS.muted, fontSize: 15, lineHeight: 1.6, maxWidth: 290, marginBottom: 16 }}>
          {slide.desc}
        </p>
        {slide.detail && (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: slide.accent + '15', border: `1px solid ${slide.accent}35`, borderRadius: 20, padding: '6px 14px' }}>
            <span style={{ fontSize: 12, color: slide.accent, fontWeight: 600 }}>{slide.detail}</span>
          </div>
        )}
      </div>

      {/* Dot-navigation + knap */}
      <div style={{ padding: '0 32px 44px', display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 6 }}>
          {SLIDES.map((_, i) => (
            <button key={i} onClick={() => setIdx(i)} aria-label={`Slide ${i + 1}`} style={{
              width: i === idx ? 28 : 8, height: 8, borderRadius: 4,
              background: i === idx ? slide.accent : COLORS.border,
              transition: 'all .3s cubic-bezier(.34,1.56,.64,1)',
              border: 'none', cursor: 'pointer', padding: 0,
            }} />
          ))}
        </div>
        <div style={{ width: '100%', maxWidth: 360, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {slide.cta ? (
            <Btn onClick={onDone}>Get Started for Free</Btn>
          ) : (
            <>
              <Btn onClick={() => setIdx(i => i + 1)} style={{ background: `linear-gradient(135deg, ${slide.accent}, ${slide.accent}cc)` }}>
                Next
              </Btn>
              <button onClick={onDone} style={{ color: COLORS.muted, fontSize: 13, fontWeight: 600, textAlign: 'center', padding: '4px 0' }}>
                Skip
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// AUTH
function AuthScreen({ onAuth }) {
  const [mode, setMode] = useState('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [gdprOk, setGdprOk] = useState(false)

  async function submit(e) {
    e.preventDefault()
    if (mode === 'signup' && !gdprOk) { setError('Please accept the privacy policy to continue.'); return }
    setLoading(true); setError('')
    try {
      const fn = mode === 'login' ? supabase.auth.signInWithPassword : supabase.auth.signUp
      const { data, error: err } = await fn.call(supabase.auth, { email, password })
      if (err) throw err
      if (mode === 'signup' && !data.session) {
        setError('Check your email for a confirmation link.')
        setLoading(false); return
      }
      onAuth(data.session)
    } catch (err) {
      setError(err.message || 'Something went wrong')
      setLoading(false)
    }
  }

  const inp = {
    background: 'linear-gradient(145deg, #0d0d14, #0a0a10)',
    border: '1px solid #1e1e28',
    borderRadius: 14,
    padding: '14px 16px',
    color: '#ffffff',
    fontSize: 16,
    width: '100%',
    outline: 'none',
    transition: 'border-color .2s',
    boxShadow: 'inset 0 2px 8px rgba(0,0,0,0.3)',
  }

  return (
    <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div className="fadeIn" style={{ width: '100%', maxWidth: 380, display: 'flex', flexDirection: 'column', gap: 24 }}>
        <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <GradeDexLogo size="md" />
          <p style={{ color: COLORS.muted, fontSize: 14, marginTop: 4 }}>{mode === 'login' ? 'Sign in to your account' : 'Create a free account'}</p>
        </div>
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input style={inp} type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} required />
          <input style={inp} type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} required minLength={6} />
          {mode === 'signup' && (
            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer', color: COLORS.muted, fontSize: 13 }}>
              <input type="checkbox" checked={gdprOk} onChange={e => setGdprOk(e.target.checked)} style={{ marginTop: 2 }} />
              <span>I agree to the <a href="/privacy.html" target="_blank" style={{ color: COLORS.gold }}>privacy policy</a> and <a href="/terms.html" target="_blank" style={{ color: COLORS.gold }}>terms of service</a></span>
            </label>
          )}
          {error && <p style={{ color: COLORS.danger, fontSize: 13, textAlign: 'center' }}>{error}</p>}
          <Btn disabled={loading}>{loading ? <Spinner size={18} color="#0a0a12" /> : mode === 'login' ? 'Sign In' : 'Create Account'}</Btn>
        </form>
        <button onClick={() => { setMode(m => m === 'login' ? 'signup' : 'login'); setError('') }} style={{ color: COLORS.muted, fontSize: 14, textAlign: 'center' }}>
          {mode === 'login' ? 'No account? Sign up for free →' : 'Already have an account? Sign in'}
        </button>
      </div>
    </div>
  )
}

// CAMERA MODAL
function CameraModal({ onCapture, onClose }) {
  const videoRef = useRef()
  const streamRef = useRef()
  const [ready, setReady] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    let cancelled = false
    async function start() {
      try {
        let stream
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: 'environment' } } })
        } catch {
          stream = await navigator.mediaDevices.getUserMedia({ video: true })
        }
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }
        streamRef.current = stream
        const video = videoRef.current
        video.srcObject = stream
        // Wait until the video has enough data to actually show a frame
        await new Promise(resolve => {
          if (video.readyState >= 2) return resolve()
          video.addEventListener('canplay', resolve, { once: true })
        })
        await video.play()
        if (!cancelled) setReady(true)
      } catch {
        if (!cancelled) setErr('Could not access camera. Allow camera permission in your browser.')
      }
    }
    start()
    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach(t => t.stop())
    }
  }, [])

  function capture() {
    const canvas = document.createElement('canvas')
    canvas.width = videoRef.current.videoWidth
    canvas.height = videoRef.current.videoHeight
    canvas.getContext('2d').drawImage(videoRef.current, 0, 0)
    streamRef.current?.getTracks().forEach(t => t.stop())
    onCapture(canvas.toDataURL('image/jpeg', 0.85))
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000', zIndex: 1000, display: 'flex', flexDirection: 'column' }}>
      <video ref={videoRef} playsInline style={{ width: '100%', flex: 1, objectFit: 'cover' }} />

      {/* Viewfinder overlay */}
      {!err && (
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingBottom: 140 }}>
          {/* Card frame — box-shadow creates the dark surround with a clear cutout window */}
          <div style={{
            position: 'relative',
            width: '62vw',
            aspectRatio: '3/4',
            maxWidth: 220,
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.58)',
            zIndex: 1,
          }}>
            {/* Top-left corner */}
            <div style={{ position: 'absolute', top: 0, left: 0, width: 28, height: 28 }}>
              <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: 3, background: COLORS.gold, borderRadius: '2px 0 0 0' }} />
              <div style={{ position: 'absolute', top: 0, left: 0, width: 3, height: '100%', background: COLORS.gold, borderRadius: '2px 0 0 0' }} />
            </div>
            {/* Top-right corner */}
            <div style={{ position: 'absolute', top: 0, right: 0, width: 28, height: 28 }}>
              <div style={{ position: 'absolute', top: 0, right: 0, width: '100%', height: 3, background: COLORS.gold, borderRadius: '0 2px 0 0' }} />
              <div style={{ position: 'absolute', top: 0, right: 0, width: 3, height: '100%', background: COLORS.gold, borderRadius: '0 2px 0 0' }} />
            </div>
            {/* Bottom-left corner */}
            <div style={{ position: 'absolute', bottom: 0, left: 0, width: 28, height: 28 }}>
              <div style={{ position: 'absolute', bottom: 0, left: 0, width: '100%', height: 3, background: COLORS.gold, borderRadius: '0 0 0 2px' }} />
              <div style={{ position: 'absolute', bottom: 0, left: 0, width: 3, height: '100%', background: COLORS.gold, borderRadius: '0 0 0 2px' }} />
            </div>
            {/* Bottom-right corner */}
            <div style={{ position: 'absolute', bottom: 0, right: 0, width: 28, height: 28 }}>
              <div style={{ position: 'absolute', bottom: 0, right: 0, width: '100%', height: 3, background: COLORS.gold, borderRadius: '0 0 2px 0' }} />
              <div style={{ position: 'absolute', bottom: 0, right: 0, width: 3, height: '100%', background: COLORS.gold, borderRadius: '0 0 2px 0' }} />
            </div>
          </div>
          <div style={{ marginTop: 20, fontSize: 13, color: '#ffffffcc', fontWeight: 600, letterSpacing: 0.3, zIndex: 1, textShadow: '0 1px 4px rgba(0,0,0,0.8)' }}>
            {ready ? 'Place the card face in the frame' : 'Starting camera…'}
          </div>
        </div>
      )}

      {err && (
        <div style={{ position: 'absolute', top: '35%', left: 20, right: 20, padding: '20px 24px', textAlign: 'center', color: COLORS.danger, fontSize: 14, background: COLORS.card, borderRadius: 16, border: `1px solid ${COLORS.danger}44` }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>🚫</div>
          {err}
        </div>
      )}

      {/* Bottom controls */}
      <div style={{
        height: 140, background: '#111e',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '0 32px', paddingBottom: 'env(safe-area-inset-bottom)',
        backdropFilter: 'blur(8px)',
      }}>
        <button onClick={onClose} style={{ color: '#ffffffcc', fontSize: 15, padding: 12, minWidth: 80, fontWeight: 600 }}>Cancel</button>

        {/* Shutter button */}
        <button
          onClick={capture}
          disabled={!ready}
          aria-label="Take photo"
          style={{
            width: 80, height: 80, borderRadius: '50%', flexShrink: 0,
            background: 'transparent',
            border: `3px solid ${ready ? '#fff' : '#555'}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'transform .1s, border-color .2s',
          }}
        >
          <div style={{
            width: 66, height: 66, borderRadius: '50%',
            background: ready ? '#fff' : '#444',
            transition: 'background .2s',
          }} />
        </button>

        <div style={{ minWidth: 80 }} />
      </div>
    </div>
  )
}

// SCAN SCREEN
function ScanScreen({ user, profile, onScanDone, modelState, modelProgress }) {
  const [game, setGame] = useState('pokemon')
  const [frontImg, setFrontImg] = useState(null)
  const [backImg, setBackImg] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const [scanMode, setScanMode] = useState('free') // 'free' | 'ai'
  const [camera, setCamera] = useState(null) // 'front' | 'back' | null
  const [logoErrs, setLogoErrs] = useState({})
  const frontRef = useRef()
  const backRef = useRef()

  function pickImage(side) {
    if (navigator.mediaDevices?.getUserMedia) {
      setCamera(side)
    } else {
      const input = side === 'front' ? frontRef.current : backRef.current
      input.click()
    }
  }

  function handleCameraCapture(dataUrl) {
    if (camera === 'front') setFrontImg(dataUrl)
    else setBackImg(dataUrl)
    setCamera(null)
    setResult(null)
  }

  async function handleFile(e, side) {
    const file = e.target.files[0]
    if (!file) return
    const compressed = await compressImage(file)
    if (side === 'front') setFrontImg(compressed)
    else setBackImg(compressed)
    setResult(null)
  }

  function cropCardNumberArea(dataUrl) {
    return new Promise(resolve => {
      const img = new Image()
      img.onload = () => {
        const cropHeight = Math.floor(img.height * 0.22)
        const cropY = img.height - cropHeight
        const canvas = document.createElement('canvas')
        canvas.width = img.width * 3
        canvas.height = cropHeight * 3
        const ctx = canvas.getContext('2d')
        ctx.imageSmoothingEnabled = true
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(img, 0, cropY, img.width, cropHeight, 0, 0, canvas.width, canvas.height)
        resolve(canvas.toDataURL('image/jpeg', 0.95))
      }
      img.onerror = () => resolve(null)
      img.src = dataUrl
    })
  }

  async function freeScan() {
    if (!frontImg) { setError('Upload the front of the card first'); return }
    setLoading(true); setError('')
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      if (!token) { setError('Not signed in — please reload'); setLoading(false); return }

      const blob = await fetch(frontImg).then(r => r.blob())
      const formData = new FormData()
      formData.append('file', blob, 'card.jpg')

      const res = await fetch(`${API_URL}/api/v1/scan?game=${game}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error?.message || `Server error ${res.status}`)
      }

      const data = await res.json()
      setResult({ type: 'free', ...data })
    } catch (e) {
      setError(e.message || 'Free scan failed — is the server running?')
    } finally {
      setLoading(false)
    }
  }

  async function analyze() {
    if (!frontImg) { setError('Upload the front of the card first'); return }
    setLoading(true); setError('')
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      if (!token) { setError('Not signed in — please reload the app'); setLoading(false); return }

      const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
      let matchedCard = null

      // Step 1: Embedding-based visual match (if model is loaded)
      try {
        const { isModelLoaded, extractEmbeddingFromDataUrl } = await import('./recognition/EmbeddingExtractor.js')
        if (isModelLoaded()) {
          const embedding = await extractEmbeddingFromDataUrl(frontImg)
          const matchRes = await fetch('/api/match', {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({ embedding, game }),
          })
          if (matchRes.ok) {
            const matchData = await matchRes.json()
            if (!matchData.fallback && matchData.confidence === 'high' && matchData.match) {
              matchedCard = matchData.match
            }
          }
        }
      } catch {
        // Embedding not available — fall through to Claude identification
      }

      // Step 2: Claude analysis — grading only if card identified, full analysis otherwise
      const numberImage = matchedCard ? null : await cropCardNumberArea(frontImg)
      const analyzeBody = { frontImage: frontImg, backImage: backImg, game }
      if (!matchedCard) analyzeBody.numberImage = numberImage
      if (matchedCard) analyzeBody.matchedCard = matchedCard

      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(analyzeBody),
      })
      let data
      try {
        data = await res.json()
      } catch {
        throw new Error('Server error — please try again in a moment')
      }
      if (!res.ok) throw new Error(data.error || 'Analysis failed')

      const raw = data.analysis
      const start = raw.indexOf('{')
      const end = raw.lastIndexOf('}')
      const parsed = JSON.parse(raw.slice(start, end + 1))
      // Normalize denominators where AI folds series prefix in: "100/XY123" → "100/123"
      if (parsed.cardNumber) {
        parsed.cardNumber = parsed.cardNumber.replace(/^(\d+)\/(XY|SV|SWSH|SM|BW|DP|HGSS)(\d+)$/i, '$1/$3')
      }

      setResult({
        ...parsed,
        officialImageUrl: data.officialImageUrl || matchedCard?.image_url || null,
        catalogId: data.catalogId || matchedCard?.id || null,
        catalogPriceEur: data.catalogPriceEur ?? matchedCard?.price_eur ?? null,
        catalogPriceAvg7: data.catalogPriceAvg7 ?? null,
        catalogPriceAvg30: data.catalogPriceAvg30 ?? null,
        catalogPriceLow: data.catalogPriceLow ?? null,
        catalogPriceSell: data.catalogPriceSell ?? null,
        catalogPriceUpdatedAt: data.catalogPriceUpdatedAt ?? null,
        catalogPriceIsRH: data.catalogPriceIsRH ?? false,
        catalogCardmarketUrl: data.catalogCardmarketUrl || matchedCard?.cardmarket_url || null,
        verifiedRarity: data.verifiedRarity || matchedCard?.rarity || null,
        verifiedSetName: data.verifiedSetName || matchedCard?.set_name || null,
        verifiedNumber: data.verifiedNumber || matchedCard?.number || null,
        _debug: { ...data.debugInfo, embeddingMatch: !!matchedCard, matchScore: matchedCard?.score },
      })
      onScanDone()
    } catch (err) {
      setError(err.message)
    }
    setLoading(false)
  }

  const scansLeft = profile?.is_pro ? `${30 - (profile?.daily_scans || 0)} today` : `${3 - (profile?.total_scans || 0)} free left`

  return (
    <div style={{ padding: '16px 16px 100px', maxWidth: 480, margin: '0 auto' }}>
      {camera && <CameraModal onCapture={handleCameraCapture} onClose={() => setCamera(null)} />}
      <input ref={frontRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={e => handleFile(e, 'front')} />
      <input ref={backRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={e => handleFile(e, 'back')} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, paddingTop: 8 }}>
        <div>
          <h2 style={{ fontWeight: 900, fontSize: 20, letterSpacing: -0.3 }}>Scan Card</h2>
          <div style={{ fontSize: 11, color: COLORS.muted, fontWeight: 500, marginTop: 1 }}>
            {scanMode === 'free' ? 'Identify card instantly — free & unlimited' : 'AI grades your card condition'}
          </div>
        </div>
        <Badge color={profile?.is_pro ? COLORS.gold : COLORS.muted}>{profile?.is_pro ? 'PRO' : scansLeft}</Badge>
      </div>

      {/* Scan mode selector */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, background: COLORS.card, borderRadius: 14, padding: 4, border: `1px solid ${COLORS.border}` }}>
        {[
          { id: 'free', label: '⚡ Free Scan', desc: 'Unlimited' },
          { id: 'ai',   label: '🤖 AI Grade',  desc: scansLeft },
        ].map(m => (
          <button key={m.id} onClick={() => { setScanMode(m.id); setResult(null); setError('') }} style={{
            flex: 1, padding: '10px 8px', borderRadius: 10,
            background: scanMode === m.id ? (m.id === 'free' ? COLORS.success + '18' : COLORS.gold + '18') : 'transparent',
            border: `1.5px solid ${scanMode === m.id ? (m.id === 'free' ? COLORS.success : COLORS.gold) : 'transparent'}`,
            color: scanMode === m.id ? (m.id === 'free' ? COLORS.success : COLORS.gold) : COLORS.muted,
            fontWeight: 700, fontSize: 13, cursor: 'pointer', transition: 'all .15s',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
          }}>
            <span>{m.label}</span>
            <span style={{ fontSize: 10, fontWeight: 500, opacity: 0.8 }}>{m.desc}</span>
          </button>
        ))}
      </div>

      {/* Game selector */}
      <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4, marginBottom: 20, scrollbarWidth: 'none' }}>
        {GAMES.map(g => {
          const active = game === g.id
          return (
            <button key={g.id} onClick={() => setGame(g.id)} style={{
              flexShrink: 0,
              padding: '8px 10px',
              borderRadius: 14,
              background: active ? g.color + '18' : COLORS.card,
              border: `1.5px solid ${active ? g.color : COLORS.border}`,
              color: active ? g.color : COLORS.muted,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              minWidth: 58,
              boxShadow: active ? `0 0 14px ${g.color}28` : 'none',
              transition: 'all .15s',
            }}>
              <div style={{ height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {!logoErrs[g.id] ? (
                  <img
                    src={GAME_LOGOS[g.id]}
                    alt={g.label}
                    onError={() => setLogoErrs(e => ({ ...e, [g.id]: true }))}
                    style={{
                      height: 32, width: 'auto', maxWidth: 58,
                      objectFit: 'contain',
                      opacity: active ? 1 : 0.45,
                      filter: active ? 'none' : 'grayscale(30%)',
                      transition: 'opacity .15s, filter .15s',
                    }}
                  />
                ) : (
                  <div style={{ color: active ? g.color : COLORS.muted }}>
                    {React.cloneElement(g.logo, { width: 28, height: 28 })}
                  </div>
                )}
              </div>
            </button>
          )
        })}
      </div>

      {/* Image upload */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
        {[{ label: 'Front', key: 'front', img: frontImg }, { label: 'Back (optional)', key: 'back', img: backImg }].map(({ label, key, img }) => (
          <button key={key} onClick={() => pickImage(key)} style={{
            aspectRatio: '3/4', borderRadius: 16,
            border: img ? `1.5px solid ${COLORS.gold}60` : `1.5px solid ${COLORS.border}`,
            background: img ? 'transparent' : `linear-gradient(145deg, ${COLORS.card}, #090910)`,
            boxShadow: img ? `0 0 16px ${COLORS.gold}18` : 'none',
            overflow: 'hidden', position: 'relative',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8,
          }}>
            {img ? (
              <>
                <img src={img} alt={label} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                <div style={{ position: 'absolute', bottom: 8, right: 8, background: COLORS.success, borderRadius: '50%', width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, boxShadow: '0 2px 8px rgba(0,0,0,0.4)' }}>✓</div>
              </>
            ) : (
              <>
                {[
                  { outer: {top:6,left:6},     inner: {top:0,left:0} },
                  { outer: {top:6,right:6},    inner: {top:0,right:0} },
                  { outer: {bottom:6,left:6},  inner: {bottom:0,left:0} },
                  { outer: {bottom:6,right:6}, inner: {bottom:0,right:0} },
                ].map(({ outer, inner }, i) => (
                  <div key={i} style={{ position: 'absolute', width: 14, height: 14, ...outer, pointerEvents: 'none' }}>
                    <div style={{ position: 'absolute', width: '100%', height: 2, background: `${COLORS.gold}88`, ...inner }} />
                    <div style={{ position: 'absolute', width: 2, height: '100%', background: `${COLORS.gold}88`, ...inner }} />
                  </div>
                ))}
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={COLORS.muted} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
                  <circle cx="12" cy="13" r="4"/>
                </svg>
                <span style={{ color: COLORS.muted, fontSize: 11, fontWeight: 600, letterSpacing: 0.3 }}>{label}</span>
              </>
            )}
          </button>
        ))}
      </div>

      {error && <p style={{ color: COLORS.danger, fontSize: 13, marginBottom: 12, textAlign: 'center' }}>{error}</p>}

      {scanMode === 'free' ? (
        <Btn onClick={freeScan} disabled={loading || !frontImg} style={{ background: loading ? COLORS.success + '99' : COLORS.success }}>
          {loading ? <><Spinner size={18} color="#0a0a12" /> Scanning...</> : '⚡ Free Scan'}
        </Btn>
      ) : (
        <Btn onClick={analyze} disabled={loading || !frontImg}>
          {loading ? <><Spinner size={18} color="#0a0a12" /> Analyzing...</> : '🤖 AI Grade Card'}
        </Btn>
      )}

      {/* Vision model status */}
      {modelState === 'loading' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, padding: '8px 14px', borderRadius: 20, background: `${COLORS.card}`, border: `1px solid ${COLORS.border}`, justifyContent: 'center' }}>
          <Spinner size={11} color={COLORS.gold} />
          <span style={{ fontSize: 11, color: COLORS.muted, fontWeight: 600 }}>
            Loading vision model{modelProgress > 0 ? ` · ${modelProgress}%` : '…'}
          </span>
          {modelProgress > 0 && (
            <div style={{ width: 48, height: 3, borderRadius: 2, background: COLORS.border, overflow: 'hidden', flexShrink: 0 }}>
              <div style={{ height: '100%', width: `${modelProgress}%`, background: `linear-gradient(90deg, ${COLORS.gold}88, ${COLORS.gold})`, borderRadius: 2, transition: 'width .3s ease' }} />
            </div>
          )}
        </div>
      )}
      {modelState === 'ready' && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 10, padding: '7px 14px', borderRadius: 20, background: `${COLORS.success}10`, border: `1px solid ${COLORS.success}25` }}>
          <span style={{ color: COLORS.success, fontSize: 12 }}>✦</span>
          <span style={{ fontSize: 11, fontWeight: 700, color: COLORS.success, letterSpacing: 0.3 }}>Vision model ready</span>
        </div>
      )}

      {/* Result */}
      {result && result.type === 'free' && (
        <FreeScanResult
          result={result}
          game={game}
          frontImg={frontImg}
          user={user}
          onSave={() => { setResult(null); setFrontImg(null); setBackImg(null); onScanDone() }}
          onSwitchToAI={() => { setResult(null); setScanMode('ai') }}
        />
      )}
      {result && result.type !== 'free' && (
        <GradeResult result={result} game={game} frontImg={frontImg} user={user} onSave={() => { setResult(null); setFrontImg(null); setBackImg(null); onScanDone() }} />
      )}
    </div>
  )
}

function FreeScanResult({ result, game, frontImg, user, onSave, onSwitchToAI }) {
  const candidates = result.autoMatched ? [result.match, ...(result.alternatives || [])] : (result.candidates || [])
  const [selected, setSelected] = useState(result.autoMatched ? result.match : candidates[0])
  const [finish, setFinish] = useState(selected?.finishTypes?.[0] || 'Normal')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState('')

  const priceRow = (selected?.card_prices || []).find(p => p.finish === finish) || {}
  const price = priceRow.price_avg7 || selected?.price_eur || null

  async function save() {
    if (!selected) return
    setSaving(true)
    const { error } = await supabase.from('cards').insert({
      user_id:       user.id,
      name:          selected.name,
      game,
      finish,
      value:         price,
      price_avg7:    priceRow.price_avg7  || null,
      price_avg30:   priceRow.price_avg30 || null,
      price_low:     priceRow.price_low   || null,
      price_sell:    priceRow.price_sell  || null,
      cardmarket_url: priceRow.cm_url     || selected.cardmarket_url || null,
      image_url:     selected.image_url   || null,
      card_number:   selected.number      || null,
      set_name:      selected.set_name    || null,
      catalog_id:    selected.id          || null,
    })
    setSaving(false)
    if (error) { setSaveError(error.message); return }
    setSaved(true)
    setTimeout(onSave, 700)
  }

  if (!selected && candidates.length === 0) {
    return (
      <div style={{ marginTop: 20, padding: 20, background: COLORS.card, borderRadius: 16, border: `1px solid ${COLORS.border}`, textAlign: 'center' }}>
        <div style={{ fontSize: 32, marginBottom: 8 }}>🔍</div>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>Card not found</div>
        <div style={{ fontSize: 13, color: COLORS.muted, marginBottom: 16 }}>
          {result.ocrText ? `OCR read: "${result.ocrText}"` : 'Could not read card name'}
        </div>
        <Btn onClick={onSwitchToAI} variant="secondary" small>Try AI Scan instead</Btn>
      </div>
    )
  }

  return (
    <div style={{ marginTop: 20 }}>
      {/* Confidence banner */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, padding: '8px 12px', borderRadius: 10, background: result.autoMatched ? `${COLORS.success}12` : `${COLORS.gold}12`, border: `1px solid ${result.autoMatched ? COLORS.success : COLORS.gold}30` }}>
        <span style={{ fontSize: 16 }}>{result.autoMatched ? '✅' : '🔎'}</span>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: result.autoMatched ? COLORS.success : COLORS.gold }}>
            {result.autoMatched ? 'Auto-matched' : 'Select the correct card'}
          </div>
          {result.ocrText && <div style={{ fontSize: 11, color: COLORS.muted }}>OCR: "{result.ocrText}"</div>}
        </div>
        <div style={{ marginLeft: 'auto', fontSize: 11, color: COLORS.muted }}>
          {Math.round((result.confidence || 0) * 100)}% confident
        </div>
      </div>

      {/* Candidate selector (if not auto-matched) */}
      {!result.autoMatched && candidates.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
          {candidates.map((c, i) => (
            <button key={c.id || i} onClick={() => { setSelected(c); setFinish(c.finishTypes?.[0] || 'Normal') }} style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px',
              borderRadius: 12, background: selected?.id === c.id ? `${COLORS.gold}12` : COLORS.card,
              border: `1.5px solid ${selected?.id === c.id ? COLORS.gold : COLORS.border}`,
              cursor: 'pointer', textAlign: 'left', width: '100%',
            }}>
              {c.image_url && <img src={c.image_url} alt={c.name} style={{ width: 36, height: 50, objectFit: 'contain', borderRadius: 4 }} />}
              <div>
                <div style={{ fontWeight: 700, fontSize: 14, color: '#fff' }}>{c.name}</div>
                <div style={{ fontSize: 11, color: COLORS.muted }}>{c.set_name} · #{c.number}</div>
              </div>
            </button>
          ))}
        </div>
      )}

      {selected && (
        <div style={{ background: COLORS.card, borderRadius: 16, border: `1px solid ${COLORS.border}`, overflow: 'hidden' }}>
          {/* Card header */}
          <div style={{ display: 'flex', gap: 14, padding: 16 }}>
            <img
              src={selected.image_url || frontImg}
              alt={selected.name}
              style={{ width: 80, height: 110, objectFit: 'contain', borderRadius: 8, background: '#111' }}
            />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 900, fontSize: 17, letterSpacing: -0.3, marginBottom: 2 }}>{selected.name}</div>
              <div style={{ fontSize: 12, color: COLORS.muted, marginBottom: 8 }}>{selected.set_name} · #{selected.number}</div>
              {selected.rarity && <Badge color={COLORS.muted} style={{ fontSize: 10 }}>{selected.rarity}</Badge>}
            </div>
          </div>

          {/* Finish selector */}
          {(selected.finishTypes || ['Normal']).length > 1 && (
            <div style={{ padding: '0 16px 12px' }}>
              <div style={{ fontSize: 11, color: COLORS.muted, marginBottom: 6, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>Finish</div>
              <div style={{ display: 'flex', gap: 6 }}>
                {(selected.finishTypes || ['Normal']).map(f => (
                  <button key={f} onClick={() => setFinish(f)} style={{
                    padding: '6px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                    background: finish === f ? `${COLORS.gold}18` : 'transparent',
                    border: `1.5px solid ${finish === f ? COLORS.gold : COLORS.border}`,
                    color: finish === f ? COLORS.gold : COLORS.muted,
                  }}>{f}</button>
                ))}
              </div>
            </div>
          )}

          {/* Prices */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, padding: '0 16px 16px' }}>
            {[
              { label: '7d avg', val: priceRow.price_avg7 || selected.price_avg7 },
              { label: '30d avg', val: priceRow.price_avg30 || selected.price_avg30 },
              { label: 'Low', val: priceRow.price_low || selected.price_eur_low },
            ].map(({ label, val }) => (
              <div key={label} style={{ background: '#0a0a14', borderRadius: 10, padding: '10px 8px', textAlign: 'center', border: `1px solid ${COLORS.border}` }}>
                <div style={{ fontSize: 10, color: COLORS.muted, marginBottom: 3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
                <div style={{ fontSize: 15, fontWeight: 900, color: val ? COLORS.gold : COLORS.muted }}>
                  {val ? `€${Number(val).toFixed(2)}` : '—'}
                </div>
              </div>
            ))}
          </div>

          {/* Actions */}
          <div style={{ padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {saveError && <p style={{ color: COLORS.danger, fontSize: 12, textAlign: 'center' }}>{saveError}</p>}
            <Btn onClick={save} disabled={saving || saved}>
              {saved ? '✓ Saved!' : saving ? <><Spinner size={16} color="#0a0a12" /> Saving...</> : '+ Save to Collection'}
            </Btn>
            <Btn onClick={onSwitchToAI} variant="secondary" small>
              🤖 Grade this card with AI
            </Btn>
          </div>
        </div>
      )}
    </div>
  )
}

function GradeResult({ result, game, frontImg, user, onSave }) {
  const gradeColor = COLORS.gold
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState('')
  const psaGrade = computePsaGrade(result.centering, result.corners, result.edges, result.surface)

  async function save() {
    setSaving(true)

    // Lav lille thumbnail (200px) og gem som data URL direkte i DB
    let imageUrl = result.officialImageUrl || null
    if (!imageUrl && frontImg) {
      imageUrl = await new Promise(resolve => {
        const img = new Image()
        img.onload = () => {
          const canvas = document.createElement('canvas')
          const ratio = Math.min(200 / img.width, 267 / img.height)
          canvas.width = img.width * ratio
          canvas.height = img.height * ratio
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
          resolve(canvas.toDataURL('image/jpeg', 0.7))
        }
        img.src = frontImg
      })
    }

    // Prefer catalog EUR price; fall back to parsing AI estimate string "40-65€" → avg
    const valueStr = result.estimatedRawValue || result.estimatedPSAValue || ''
    const nums = [...valueStr.matchAll(/\d+/g)].map(m => parseFloat(m[0]))
    const parsedValueNum = nums.length >= 2 ? (nums[0] + nums[1]) / 2 : nums[0] || null
    const valueNum = result.catalogPriceEur || parsedValueNum || null

    const { error } = await supabase.from('cards').insert({
      user_id: user.id,
      name: result.cardName || result.name || result.kortNavn || null,
      game,
      grade: psaGrade?.grade ?? 7,
      finish: result.verifiedRarity || result.finish || null,
      value: valueNum,
      price_range: result.estimatedRawValue || result.estimatedPSAValue || null,
      image_url: result.officialImageUrl || imageUrl,
      notes: result.recommendation,
      card_number: result.verifiedNumber || result.cardNumber || null,
      set_name: result.verifiedSetName || result.setName || null,
      catalog_id: result.catalogId || null,
      price_avg30: result.catalogPriceAvg30 || null,
      cardmarket_url: result.catalogCardmarketUrl || null,
    })
    if (error) {
      setSaveError(error.message)
      setSaving(false)
      return
    }
    setSaveError('')
    setSaved(true)
    setTimeout(onSave, 800)
    setSaving(false)
  }

  function share() {
    if (navigator.share) {
      navigator.share({ title: 'GradeDex Analysis', text: `Near Mint — ${result.recommendation}`, url: window.location.href })
    }
  }

  const gradeBg = `linear-gradient(135deg, ${COLORS.gold}22, ${COLORS.gold}08)`
  const confidenceColor = result.confidence === 'High' ? COLORS.success : result.confidence === 'Mid' ? COLORS.gold : COLORS.muted

  const subGradeScore = (text) => {
    if (!text) return null
    const lower = text.toLowerCase()
    if (lower.includes('perfect') || lower.includes('excellent') || lower.includes('none') || lower.includes('no issues')) return 10
    if (lower.includes('minimal') || lower.includes('slight') || lower.includes('minor')) return 7
    if (lower.includes('moderate') || lower.includes('some') || lower.includes('visible')) return 5
    return null
  }

  const subGrades = [
    ['Centering', result.centering],
    ['Corners', result.corners],
    ['Edges', result.edges],
    ['Surface', result.surface],
  ]

  return (
    <Card style={{ marginTop: 20, padding: 0, overflow: 'hidden' }} className="slideUp">
      {result._debug?.embeddingMatch && (
        <div style={{
          background: `linear-gradient(90deg, ${COLORS.success}15, ${COLORS.success}08)`,
          borderBottom: `1px solid ${COLORS.success}25`,
          padding: '8px 20px',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span style={{ color: COLORS.success, fontSize: 14 }}>✦</span>
          <span style={{ fontSize: 11, fontWeight: 700, color: COLORS.success, letterSpacing: 0.5 }}>
            Matched by Vision AI
          </span>
          {result._debug?.matchScore && (
            <span style={{ fontSize: 10, color: `${COLORS.success}99`, marginLeft: 'auto' }}>
              {Math.round(result._debug.matchScore * 100)}% confidence
            </span>
          )}
        </div>
      )}
      {/* Hero header med kort-billede og grade-cirkel side om side */}
      <div style={{ background: gradeBg, padding: '20px 20px 0', borderBottom: `1px solid ${COLORS.border}` }}>
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', marginBottom: 20 }}>
          {/* Kortbillede */}
          {(result.officialImageUrl || frontImg) && (
            <div style={{ position: 'relative', flexShrink: 0 }}>
              <img
                src={result.officialImageUrl || frontImg}
                alt="card"
                style={{ width: 72, aspectRatio: '3/4', objectFit: 'cover', borderRadius: 10, boxShadow: '0 4px 20px #0008' }}
              />
              {result.officialImageUrl && (
                <div style={{ position: 'absolute', bottom: 4, right: 4, background: COLORS.success, borderRadius: 4, width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10 }}>✓</div>
              )}
            </div>
          )}

          {/* Kortnavn + grade */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: COLORS.muted, marginBottom: 2, textTransform: 'uppercase', letterSpacing: 0.8, fontWeight: 600 }}>AI Analysis Result</div>
            <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 4, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {result.cardName || 'Unknown Card'}
            </div>
            {(result.verifiedRarity || result.finish || result.verifiedSetName || result.setName) && (
              <div style={{ fontSize: 11, marginBottom: 10, lineHeight: 1.5 }}>
                <span style={{ color: COLORS.gold, fontWeight: 700 }}>
                  {result.verifiedRarity || result.finish}
                </span>
                {(result.verifiedSetName || result.setName) && (
                  <span style={{ color: COLORS.muted }}> · {result.verifiedSetName || result.setName}</span>
                )}
                {(result.verifiedNumber || result.cardNumber) && (
                  <span style={{ color: COLORS.muted }}> · #{result.verifiedNumber || result.cardNumber}</span>
                )}
                {result.verifiedRarity && (
                  <span style={{ color: COLORS.success, fontSize: 10 }}> ✓</span>
                )}
              </div>
            )}

            {/* Condition badge — computed PSA grade */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ position: 'relative', display: 'inline-block' }}>
                <div style={{
                  width: 72, height: 72, borderRadius: '50%',
                  background: `radial-gradient(circle at 35% 30%, ${COLORS.gold}30, ${COLORS.gold}08)`,
                  border: `2px solid ${COLORS.gold}55`,
                  boxShadow: `0 0 24px ${COLORS.gold}30, inset 0 1px 0 ${COLORS.gold}40`,
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0,
                }}>
                  <span style={{ fontSize: psaGrade ? 22 : 14, fontWeight: 900, color: COLORS.gold, lineHeight: 1, letterSpacing: -0.5 }} className="gradeReveal">
                    {psaGrade ? 'PSA' : '—'}
                  </span>
                  <span style={{ fontSize: psaGrade ? 26 : 12, fontWeight: 900, color: '#fff', lineHeight: 1, letterSpacing: -1 }} className="gradeReveal">
                    {psaGrade?.grade ?? '?'}
                  </span>
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: gradeColor, lineHeight: 1, letterSpacing: -0.3 }}>
                  {psaGrade?.label || result.confidence || 'Analyzing…'}
                </div>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: confidenceColor + '22', border: `1px solid ${confidenceColor}44`, borderRadius: 6, padding: '2px 8px' }}>
                  <div style={{ width: 6, height: 6, borderRadius: '50%', background: confidenceColor }} />
                  <span style={{ fontSize: 11, fontWeight: 700, color: confidenceColor }}>{result.confidence} Confidence</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Sub-grade progress bars */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, paddingBottom: 20 }}>
          {subGrades.map(([label, value]) => {
            const score = subGradeScore(value)
            const barColor = score >= 9 ? COLORS.success : score >= 6 ? COLORS.gold : score ? '#e67e22' : COLORS.border
            return (
              <div key={label} style={{ background: `${COLORS.bg}ee`, borderRadius: 10, padding: '10px 12px', border: `1px solid ${COLORS.border}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <span style={{ fontSize: 10, color: COLORS.muted, textTransform: 'uppercase', letterSpacing: 0.8, fontWeight: 700 }}>{label}</span>
                  {score !== null && (
                    <span style={{
                      fontSize: 10, fontWeight: 800, color: barColor,
                      background: `${barColor}18`, borderRadius: 4, padding: '2px 6px',
                    }}>{score}/10</span>
                  )}
                </div>
                {score !== null && (
                  <div style={{ height: 5, background: `${COLORS.border}`, borderRadius: 3, marginBottom: 6, overflow: 'hidden' }}>
                    <div style={{
                      height: '100%', width: `${score * 10}%`, background: `linear-gradient(90deg, ${barColor}cc, ${barColor})`,
                      borderRadius: 3, transition: 'width .8s cubic-bezier(.34,1.1,.64,1)',
                    }} />
                  </div>
                )}
                <div style={{ fontSize: 11, fontWeight: 600, color: COLORS.text, lineHeight: 1.4 }}>{value || '—'}</div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Body */}
      <div style={{ padding: '16px 20px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>

        {/* Fundne problemer */}
        {result.mainIssues?.length > 0 && (
          <div style={{ background: COLORS.danger + '0d', border: `1px solid ${COLORS.danger}33`, borderRadius: 12, padding: 14 }}>
            <div style={{ fontSize: 11, color: COLORS.danger, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.6, fontWeight: 700 }}>
              Issues Found ({result.mainIssues.length})
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {result.mainIssues.map((issue, i) => (
                <div key={i} style={{ fontSize: 13, color: COLORS.muted, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <span style={{ color: COLORS.danger, flexShrink: 0, marginTop: 1 }}>—</span>
                  <span>{issue}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Pris-sektion */}
        <div style={{ background: `linear-gradient(135deg, ${COLORS.bg}, #0a0a12)`, borderRadius: 14, padding: '14px 16px', border: `1px solid ${COLORS.border}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 10, color: COLORS.muted, textTransform: 'uppercase', letterSpacing: 1, fontWeight: 700, marginBottom: 4 }}>
                {result.catalogPriceEur
                  ? `Cardmarket${result.catalogPriceIsRH ? ' · Reverse Holo' : ''}`
                  : 'Raw Market Est.'}
              </div>
              <div style={{ fontSize: 28, fontWeight: 700, color: COLORS.gold, fontFamily: FONT_VALUE, letterSpacing: -0.5, lineHeight: 1 }}>
                {result.catalogPriceEur
                  ? new Intl.NumberFormat('da-DK', { style: 'currency', currency: 'EUR' }).format(result.catalogPriceEur)
                  : (result.estimatedRawValue || result.estimatedPSAValue || '—')
                }
              </div>
              {result.catalogPriceUpdatedAt && (
                <div style={{ fontSize: 10, color: COLORS.muted, marginTop: 3 }}>
                  updated {result.catalogPriceUpdatedAt.replace(/\//g, '-')}
                </div>
              )}
            </div>
            {result.catalogCardmarketUrl && (
              <a href={result.catalogCardmarketUrl} target="_blank" rel="noreferrer" style={{
                display: 'flex', alignItems: 'center', gap: 4,
                background: `${COLORS.gold}15`, border: `1px solid ${COLORS.gold}35`,
                borderRadius: 8, padding: '6px 10px', textDecoration: 'none',
                color: COLORS.gold, fontSize: 11, fontWeight: 700, letterSpacing: 0.3,
                flexShrink: 0,
              }}>
                Cardmarket ↗
              </a>
            )}
          </div>
          {result.catalogPriceEur && (result.catalogPriceAvg7 || result.catalogPriceAvg30 || result.catalogPriceLow) && (
            <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
              {result.catalogPriceAvg7 && (
                <div style={{ background: `${COLORS.gold}10`, border: `1px solid ${COLORS.gold}20`, borderRadius: 6, padding: '4px 8px' }}>
                  <div style={{ fontSize: 9, color: COLORS.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700 }}>7d avg</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.gold }}>
                    {new Intl.NumberFormat('da-DK', { style: 'currency', currency: 'EUR' }).format(result.catalogPriceAvg7)}
                  </div>
                </div>
              )}
              {result.catalogPriceAvg30 && (
                <div style={{ background: `${COLORS.gold}10`, border: `1px solid ${COLORS.gold}20`, borderRadius: 6, padding: '4px 8px' }}>
                  <div style={{ fontSize: 9, color: COLORS.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700 }}>30d avg</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.gold }}>
                    {new Intl.NumberFormat('da-DK', { style: 'currency', currency: 'EUR' }).format(result.catalogPriceAvg30)}
                  </div>
                </div>
              )}
              {result.catalogPriceLow && (
                <div style={{ background: `${COLORS.success}10`, border: `1px solid ${COLORS.success}20`, borderRadius: 6, padding: '4px 8px' }}>
                  <div style={{ fontSize: 9, color: COLORS.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700 }}>low</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.success }}>
                    {new Intl.NumberFormat('da-DK', { style: 'currency', currency: 'EUR' }).format(result.catalogPriceLow)}
                  </div>
                </div>
              )}
            </div>
          )}
          <div style={{ height: 1, background: `${COLORS.border}`, marginBottom: 10 }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: COLORS.muted }}>PSA Grading Fee</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: COLORS.text }}>{result.gradingFee || '~25€'}</span>
          </div>
          {result.catalogPriceEur && (result.estimatedRawValue || result.estimatedPSAValue) && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
              <span style={{ fontSize: 12, color: COLORS.muted }}>AI Raw Est.</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: `${COLORS.gold}cc` }}>{result.estimatedRawValue || result.estimatedPSAValue}</span>
            </div>
          )}
        </div>

        {/* Anbefaling */}
        <div style={{
          background: result.worthGrading ? COLORS.success + '0d' : COLORS.danger + '0d',
          border: `1px solid ${result.worthGrading ? COLORS.success : COLORS.danger}33`,
          borderRadius: 12, padding: 14,
          borderLeft: `3px solid ${result.worthGrading ? COLORS.success : COLORS.danger}`,
        }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: result.worthGrading ? COLORS.success : COLORS.danger, marginBottom: 6 }}>
            {result.worthGrading ? 'Recommended for PSA Grading' : 'Grading Not Recommended'}
          </div>
          <div style={{ fontSize: 13, color: COLORS.muted, lineHeight: 1.5 }}>{
            // If PTCG verified a different rarity, replace AI's wrong finish term in the text
            (result.verifiedRarity && result.finish && result.verifiedRarity !== result.finish && result.recommendation)
              ? result.recommendation.replace(new RegExp(result.finish.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), result.verifiedRarity)
              : result.recommendation
          }</div>
        </div>

        {/* Handlingsknapper */}
        {saveError && <p style={{ color: COLORS.danger, fontSize: 12, textAlign: 'center', marginBottom: 4 }}>{saveError}</p>}
        <div style={{ display: 'flex', gap: 10, paddingTop: 4 }}>
          <Btn onClick={save} disabled={saving || saved} small style={{ flex: 1 }}>
            {saved ? '✓ Saved to Collection' : saving ? <Spinner size={16} color="#0a0a12" /> : 'Save to Collection'}
          </Btn>
          {navigator.share && (
            <button onClick={share} style={{ flexShrink: 0, width: 44, height: 44, borderRadius: 12, background: COLORS.card, border: `1.5px solid ${COLORS.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }} aria-label="Share analysis">
              ↑
            </button>
          )}
        </div>

        {/* Debug info */}
        {result._debug && (
          <div style={{ background: '#111', border: '1px solid #333', borderRadius: 10, padding: 10, marginTop: 12, fontSize: 10, color: '#aaa', fontFamily: 'monospace', lineHeight: 1.6 }}>
            <div style={{ color: COLORS.gold, fontWeight: 700, marginBottom: 4 }}>🔍 Catalog Debug</div>
            <div>AI name: <b style={{ color: '#fff' }}>{result.cardName || '—'}</b> · HP: <b style={{ color: result._debug.hp ? COLORS.success : '#666' }}>{result._debug.hp || '—'}</b> · era: <b style={{ color: '#fff' }}>{result._debug.setEra || '—'}</b></div>
            <div>AI ability: <b style={{ color: result._debug.ability ? '#a78bfa' : '#666' }}>{result._debug.ability || 'none'}</b></div>
            <div>AI  num: <b style={{ color: result.cardNumber ? '#fff' : COLORS.danger }}>{result.cardNumber || 'null'}</b> · set: <b style={{ color: '#fff' }}>{result.setName || 'null'}</b></div>
            <div>AI  fin: <b style={{ color: result.finish ? '#fff' : COLORS.danger }}>{result.finish || 'null'}</b>{result._debug.finishOverride ? <span style={{ color: '#e67e22' }}> ⚠ {result._debug.finishOverride}</span> : null}</div>
            {(result.verifiedRarity || result.verifiedSetName) && (
              <div>DB  <b style={{ color: COLORS.gold }}>{result.verifiedRarity || '—'}</b> · <b style={{ color: COLORS.gold }}>{result.verifiedSetName || '—'}</b> · <b style={{ color: COLORS.gold }}>#{result.verifiedNumber || '?'}</b></div>
            )}
            <div>ptcg pass: <b style={{ color: '#fff' }}>{result._debug.ptcgQ || '—'}</b> · <b style={{ color: result._debug.ptcgCount > 0 ? COLORS.success : COLORS.danger }}>{result._debug.ptcgCount ?? '?'} hits</b>{result._debug.pickScore != null ? <span style={{ color: '#a78bfa' }}> · score {result._debug.pickScore}%</span> : null}</div>
            <div>Strategy: <b style={{ color: '#fff' }}>{result._debug.source || '—'}</b> · ID: <b style={{ color: '#fff' }}>{result.catalogId || '—'}</b> · key: <b style={{ color: result._debug.hasApiKey ? COLORS.success : COLORS.danger }}>{result._debug.hasApiKey ? '✓' : '✗'}</b></div>
            {result._debug.supabaseReverted && <div style={{ color: '#f59e0b', fontSize: 11 }}>↩ {result._debug.supabaseReverted}</div>}
            {result._debug.rarityFromAi && <div style={{ color: '#f59e0b', fontSize: 11 }}>rarity←AI: {result._debug.rarityFromAi}</div>}
            {result._debug.rarityForcedUR && <div style={{ color: COLORS.success, fontSize: 11 }}>⚠ {result._debug.rarityForcedUR}</div>}
            {result._debug.rarityDbg && <div style={{ color: '#a78bfa', fontSize: 11 }}>rarity: {result._debug.rarityDbg}</div>}
            {result._debug.ptcgUrNumHit && <div style={{ color: COLORS.success, fontSize: 11 }}>UR num: {result._debug.ptcgUrNumHit}</div>}
            {result._debug.ptcgUrAbilityHit && <div style={{ color: COLORS.success, fontSize: 11 }}>UR ability: {result._debug.ptcgUrAbilityHit}</div>}
            {result._debug.ptcgGlobalUr && <div style={{ color: COLORS.success, fontSize: 11 }}>global-UR: {result._debug.ptcgGlobalUr}</div>}
            {result._debug.megaHpSetOverride && <div style={{ color: '#f59e0b', fontSize: 11 }}>megaHP: {result._debug.megaHpSetOverride}</div>}
            {result._debug.setFromHp && <div style={{ color: '#f59e0b', fontSize: 11 }}>setHP: {result._debug.setFromHp}</div>}
            {result._debug.gurCheck && <div style={{ color: '#94a3b8', fontSize: 11 }}>gurCheck: {result._debug.gurCheck}</div>}
            {result._debug.gurAttempt && <div style={{ color: '#a78bfa', fontSize: 11 }}>gur: {result._debug.gurAttempt} · A:{result._debug.gurCountA ?? '?'} B:{result._debug.gurCountB ?? '?'} C:{result._debug.gurCountC ?? '?'}{result._debug.gurError ? ` ❌${result._debug.gurError}` : ''}</div>}
            {result._debug.gurCIds && <div style={{ color: '#94a3b8', fontSize: 10 }}>gurC: {result._debug.gurCIds}</div>}
            {result._debug.numNorm && <div style={{ color: '#e67e22', fontSize: 11 }}>numNorm: {result._debug.numNorm}</div>}
            {result._debug.ptcgSkipped && <div style={{ color: '#e67e22', fontSize: 11 }}>{result._debug.ptcgSkipped}</div>}
            {result._debug.ptcgStatus && <div style={{ color: '#e67e22' }}>ptcg HTTP {result._debug.ptcgStatus} (Vercel IP blokeret?)</div>}
            {result._debug.ptcgError && <div style={{ color: COLORS.danger }}>ptcg err: {result._debug.ptcgError}</div>}
            {result._debug.error && <div style={{ color: COLORS.danger }}>err: {result._debug.error}</div>}
          </div>
        )}
      </div>
    </Card>
  )
}

// SVG AREA CHART — real portfolio history from card addition timestamps
function buildPortfolioHistory(cards, period) {
  const N = 30
  const now = Date.now()
  const MS = { '1D': 86400000, '7D': 604800000, '1M': 2592000000, '3M': 7776000000, '6M': 15552000000 }
  const sorted = [...cards]
    .filter(c => c.created_at)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
  if (!sorted.length) return []
  const firstT = new Date(sorted[0].created_at).getTime()
  const windowMs = MS[period] || null
  const startT = windowMs ? Math.max(now - windowMs, firstT - 1) : firstT - 1
  const range = now - startT
  if (range <= 0) return []
  const points = []
  for (let i = 0; i < N; i++) {
    const t = startT + (i / (N - 1)) * range
    let v = 0
    for (const c of sorted) {
      if (new Date(c.created_at).getTime() <= t) v += (c.value || 0)
    }
    points.push(v)
  }
  return points
}

function buildDelta(cards, period) {
  const now = Date.now()
  const MS = { '1D': 86400000, '7D': 604800000, '1M': 2592000000, '3M': 7776000000, '6M': 15552000000 }
  const labels = { '1D': '24h', '7D': '7d', '1M': '30d', '3M': '3mo', '6M': '6mo' }
  const totalNow = cards.reduce((s, c) => s + (c.value || 0), 0)
  const windowMs = MS[period]
  if (!windowMs) return { absolute: totalNow, percent: null, isPositive: true, label: 'all time' }
  const cutoff = now - windowMs
  const addedInPeriod = cards
    .filter(c => c.created_at && new Date(c.created_at).getTime() >= cutoff)
    .reduce((s, c) => s + (c.value || 0), 0)
  const valueBefore = totalNow - addedInPeriod
  const percent = valueBefore > 0 ? (addedInPeriod / valueBefore) * 100 : null
  return { absolute: addedInPeriod, percent, isPositive: addedInPeriod >= 0, label: labels[period] }
}

function SVGAreaChart({ points, width = 480, height = 160 }) {
  if (!points || points.length < 2) return null
  const min = Math.min(...points)
  const max = Math.max(...points)
  const range = max - min || 1
  const pad = 8

  const xs = points.map((_, i) => pad + (i / (points.length - 1)) * (width - pad * 2))
  const ys = points.map(v => height - pad - ((v - min) / range) * (height - pad * 2))

  let d = `M ${xs[0]} ${ys[0]}`
  for (let i = 1; i < points.length; i++) {
    const cpx = (xs[i - 1] + xs[i]) / 2
    d += ` C ${cpx} ${ys[i - 1]}, ${cpx} ${ys[i]}, ${xs[i]} ${ys[i]}`
  }
  const area = d + ` L ${xs[xs.length - 1]} ${height} L ${xs[0]} ${height} Z`

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      style={{ display: 'block', overflow: 'visible' }}
    >
      <defs>
        <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={COLORS.gold} stopOpacity="0.35" />
          <stop offset="100%" stopColor={COLORS.gold} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#chartGrad)" />
      <path d={d} fill="none" stroke={COLORS.gold} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={xs[xs.length - 1]} cy={ys[ys.length - 1]} r="4" fill={COLORS.gold} />
    </svg>
  )
}

// HOME SCREEN
const CURRENCIES = ['EUR', 'USD', 'DKK', 'GBP']
const EXCHANGE_RATES = { EUR: 1, USD: 1.08, DKK: 7.46, GBP: 0.85 }

function HomeScreen({ user, profile, onGoScan, onViewAll }) {
  const [cards, setCards] = useState([])
  const [loading, setLoading] = useState(true)
  const [hideValue, setHideValue] = useState(false)
  const [period, setPeriod] = useState('1M')
  const [homeTab, setHomeTab] = useState('overview')
  const [currency, setCurrency] = useState(() => localStorage.getItem('gradedex_currency') || 'EUR')

  function cycleCurrency() {
    const next = CURRENCIES[(CURRENCIES.indexOf(currency) + 1) % CURRENCIES.length]
    setCurrency(next)
    localStorage.setItem('gradedex_currency', next)
  }

  const fmtVal = (val) => formatCurrency(val, currency)

  useEffect(() => {
    supabase.from('cards')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true })
      .then(({ data }) => {
        setCards(data || [])
        setLoading(false)
      })
  }, [])

  const totalValue = cards.reduce((s, c) => s + (c.value || 0), 0)
  const displayValue = loading ? 0 : totalValue
  const deltaInfo = useMemo(() => buildDelta(cards, period), [cards, period])
  const chartPoints = useMemo(() => buildPortfolioHistory(cards, period), [cards, period])
  const topCards = useMemo(() => [...cards].sort((a, b) => (b.value || 0) - (a.value || 0)).slice(0, 4), [cards])
  const topMovers = useMemo(() => {
    const withTrend = cards.map(c => ({ ...c, trend: getRealTrend(c) })).filter(c => c.trend !== null)
    return withTrend.sort((a, b) => Math.abs(b.trend) - Math.abs(a.trend)).slice(0, 4)
  }, [cards])
  const hasTrendData = topMovers.length > 0
  const uniqueSets = useMemo(() => new Set(cards.filter(c => c.set_name).map(c => c.set_name)).size, [cards])
  const bestGrade = useMemo(() => {
    const grades = cards.filter(c => c.grade).map(c => Number(c.grade))
    return grades.length ? Math.max(...grades) : null
  }, [cards])
  const uniqueGames = useMemo(() => new Set(cards.map(c => c.game)).size, [cards])
  const periods = ['1D', '7D', '1M', '3M', '6M', 'MAX']

  return (
    <div style={{ paddingBottom: 100, maxWidth: 480, margin: '0 auto' }}>

      {/* Header: logo + currency */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 16px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <div style={{
            width: 30, height: 30, borderRadius: '50%',
            border: `2px solid ${COLORS.gold}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: `0 0 12px rgba(212,175,55,0.30)`,
            background: `radial-gradient(circle at 35% 35%, rgba(212,175,55,0.15), transparent 70%)`,
            flexShrink: 0,
          }}>
            <span style={{ fontSize: 15, fontWeight: 900, color: COLORS.text, lineHeight: 1, letterSpacing: -0.5 }}>G</span>
          </div>
          <span style={{ fontSize: 17, fontWeight: 900, color: COLORS.text, letterSpacing: -0.4, lineHeight: 1 }}>
            Grade<span style={{ color: COLORS.gold }}>Dex</span>
          </span>
        </div>
        <button
          onClick={cycleCurrency}
          style={{
            display: 'flex', alignItems: 'center', gap: 5,
            padding: '7px 13px', borderRadius: 12,
            background: COLORS.card, border: `1px solid ${COLORS.border}`,
            cursor: 'pointer', transition: 'border-color .15s',
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 700, color: COLORS.text, letterSpacing: 0.3 }}>{currency}</span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={COLORS.muted} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
      </div>

      {/* Top tab bar */}
      <div style={{ display: 'flex', alignItems: 'center', borderBottom: `1px solid ${COLORS.border}`, paddingLeft: 16, paddingRight: 16 }}>
        {[['overview', 'Overview'], ['performance', 'Performance']].map(([id, label]) => (
          <button
            key={id}
            onClick={() => id === 'performance' ? window.open(STRIPE_URL, '_blank') : setHomeTab(id)}
            style={{
              marginRight: 24, paddingBottom: 12, background: 'none', border: 'none',
              borderBottom: homeTab === id ? `2px solid #D4AF37` : '2px solid transparent',
              color: homeTab === id ? COLORS.text : COLORS.muted,
              fontWeight: homeTab === id ? 700 : 500, fontSize: 15,
              cursor: 'pointer', transition: 'all .15s', display: 'flex', alignItems: 'center', gap: 6,
              textShadow: homeTab === id ? '0 0 12px rgba(212,175,55,0.3)' : 'none',
            }}
          >
            {label}
            {id === 'performance' && (
              <span style={{ background: COLORS.gold, color: '#080808', fontSize: 9, fontWeight: 900, borderRadius: 4, padding: '2px 5px', letterSpacing: 0.5 }}>PRO</span>
            )}
          </button>
        ))}
      </div>

      <div style={{ padding: '20px 16px 0' }}>

        {/* Portfolio label + collection name */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 12 }}>
          <span style={{ fontSize: 13, color: COLORS.muted, fontWeight: 600 }}>Portfolio</span>
          <button onClick={onViewAll} style={{ fontSize: 13, color: COLORS.gold, fontWeight: 800, background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline', textDecorationColor: `${COLORS.gold}55`, textUnderlineOffset: 3 }}>My Collection</button>
        </div>

        {/* Value hero row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
          <div style={{ fontSize: 44, fontWeight: 700, letterSpacing: -1, fontFamily: FONT_VALUE, lineHeight: 1, fontVariantNumeric: 'tabular-nums', textShadow: '0 0 30px rgba(212,175,55,0.15)' }}>
            {hideValue ? `••••• ${currency}` : (loading ? '—' : fmtVal(displayValue))}
          </div>
          <button
            onClick={() => setHideValue(v => !v)}
            style={{
              width: 36, height: 36, borderRadius: '50%',
              background: COLORS.card, border: `1px solid ${COLORS.border}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', flexShrink: 0,
            }}
            aria-label={hideValue ? 'Show value' : 'Hide value'}
          >
            {hideValue ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={COLORS.muted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={COLORS.muted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            )}
          </button>
        </div>

        {/* Delta line */}
        {!loading && displayValue > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 16 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: deltaInfo.absolute > 0 ? COLORS.success : deltaInfo.absolute < 0 ? COLORS.danger : COLORS.muted }}>
              {deltaInfo.absolute > 0 ? '+' : ''}{deltaInfo.absolute !== 0 ? fmtVal(deltaInfo.absolute) : '—'}
            </span>
            {deltaInfo.percent !== null && (
              <span style={{ fontSize: 11, color: COLORS.muted }}>
                ({deltaInfo.percent > 0 ? '+' : ''}{deltaInfo.percent.toFixed(1)}%)
              </span>
            )}
            <span style={{ fontSize: 11, color: COLORS.muted }}>last {deltaInfo.label}</span>
          </div>
        )}

        {/* SVG chart */}
        <div style={{ margin: '0 -16px', marginBottom: 12 }}>
          <SVGAreaChart points={chartPoints} width={480} height={160} />
        </div>

        {/* Period selector */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28, background: 'transparent' }}>
          {periods.map(p => (
            <button
              key={p}
              onClick={() => p !== 'MAX' && setPeriod(p)}
              style={{
                padding: '6px 10px', borderRadius: 20, border: 'none',
                background: period === p ? 'linear-gradient(135deg, #ffffff, #e8e8e0)' : 'transparent',
                boxShadow: period === p ? '0 2px 8px rgba(0,0,0,0.4)' : 'none',
                color: period === p ? '#080808' : COLORS.muted,
                fontWeight: period === p ? 700 : 500, fontSize: 13,
                cursor: p === 'MAX' ? 'default' : 'pointer',
                display: 'flex', alignItems: 'center', gap: 4,
                transition: 'all .15s',
              }}
            >
              {p}
              {p === 'MAX' && (
                <span style={{ background: COLORS.gold, color: '#080808', fontSize: 8, fontWeight: 900, borderRadius: 3, padding: '1px 4px' }}>PRO</span>
              )}
            </button>
          ))}
        </div>

        {/* Most valuable + Top Movers */}
        {!loading && cards.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 24 }}>

            {/* Mest værdifulde */}
            <div style={{ background: '#0d0d14', borderRadius: 16, border: `1px solid rgba(212,175,55,0.35)`, boxShadow: '0 0 18px rgba(212,175,55,0.12), inset 0 1px 0 rgba(212,175,55,0.08)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <div style={{ padding: '14px 14px 10px', fontWeight: 800, fontSize: 13, color: COLORS.text, letterSpacing: 0.1 }}>
                Most Valuable
                <div style={{ marginTop: 6, height: 1, width: 80, borderRadius: 2, background: `linear-gradient(to right, ${COLORS.gold}, transparent)` }} />
              </div>
              {topCards.map(card => {
                const dailyChange = getDailyChange(card.id)
                const changeColor = dailyChange >= 0 ? COLORS.success : COLORS.danger
                const condition = getPsaCondition(card.grade)
                const meta = [card.set_name || condition, card.finish].filter(Boolean).join(' • ')
                return (
                  <div key={card.id} style={{ padding: '8px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ flex: 1, minWidth: 0, marginRight: 6 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 2 }}>
                        {card.name || 'Unknown'}
                      </div>
                      <div style={{ fontSize: 10, color: COLORS.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {meta || 'Near Mint'}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.text, fontFamily: FONT_VALUE, fontVariantNumeric: 'tabular-nums', marginBottom: 2 }}>
                        {fmtVal(card.value)}
                      </div>
                      <div style={{ fontSize: 10, color: changeColor, fontWeight: 600 }}>
                        {dailyChange >= 0 ? '+' : ''}{dailyChange.toFixed(2)}%
                      </div>
                    </div>
                  </div>
                )
              })}
              <button onClick={onViewAll} style={{ marginTop: 'auto', padding: '10px 14px', color: COLORS.gold, fontWeight: 700, fontSize: 11, background: 'none', border: 'none', borderTop: '1px solid rgba(255,255,255,0.06)', cursor: 'pointer', width: '100%', textAlign: 'center', letterSpacing: 0.2 }}>
                View All
              </button>
            </div>

            {/* Top Movers */}
            <div style={{ background: '#0d0d14', borderRadius: 16, border: `1px solid rgba(212,175,55,0.35)`, boxShadow: '0 0 18px rgba(212,175,55,0.12), inset 0 1px 0 rgba(212,175,55,0.08)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <div style={{ padding: '14px 14px 10px', fontWeight: 800, fontSize: 13, color: COLORS.text, letterSpacing: 0.1 }}>
                Top Movers
                <div style={{ fontSize: 9, color: COLORS.muted, fontWeight: 500, marginTop: 2, letterSpacing: 0 }}>7d vs 30d avg · Cardmarket</div>
                <div style={{ marginTop: 6, height: 1, width: 80, borderRadius: 2, background: `linear-gradient(to right, ${COLORS.gold}, transparent)` }} />
              </div>
              {hasTrendData ? topMovers.map(card => {
                const trend = card.trend
                const changeColor = trend >= 0 ? COLORS.success : COLORS.danger
                return (
                  <div key={card.id} style={{ padding: '8px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ flex: 1, minWidth: 0, marginRight: 6 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 2 }}>
                        {card.name || 'Unknown'}
                      </div>
                      <div style={{ fontSize: 10, color: COLORS.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {[card.finish, card.set_name].filter(Boolean).join(' • ') || 'Near Mint'}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontSize: 13, color: changeColor, fontWeight: 700, marginBottom: 2 }}>
                        {trend >= 0 ? '+' : ''}{trend.toFixed(1)}%
                      </div>
                      <div style={{ fontSize: 10, color: COLORS.muted, fontFamily: FONT_VALUE, fontVariantNumeric: 'tabular-nums' }}>
                        {fmtVal(card.value)}
                      </div>
                    </div>
                  </div>
                )
              }) : (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px 14px', textAlign: 'center' }}>
                  <div>
                    <div style={{ fontSize: 10, color: COLORS.muted, lineHeight: 1.5 }}>Rescan cards to see</div>
                    <div style={{ fontSize: 10, color: COLORS.muted, lineHeight: 1.5 }}>real price trends</div>
                  </div>
                </div>
              )}
              <button onClick={onViewAll} style={{ marginTop: 'auto', padding: '10px 14px', color: COLORS.gold, fontWeight: 700, fontSize: 11, background: 'none', border: 'none', borderTop: '1px solid rgba(255,255,255,0.06)', cursor: 'pointer', width: '100%', textAlign: 'center', letterSpacing: 0.2 }}>
                View All
              </button>
            </div>

          </div>
        )}

        {/* Stats row */}
        {!loading && cards.length > 0 && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 28, flexWrap: 'wrap' }}>
            {[
              { label: 'Cards', value: cards.length },
              { label: 'Sets', value: uniqueSets || '—' },
              { label: 'Best Grade', value: bestGrade ? `PSA ${bestGrade}` : '—' },
              { label: 'Games', value: uniqueGames },
            ].map(({ label, value }) => (
              <div key={label} style={{ flex: 1, minWidth: 68, background: COLORS.card, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: '8px 10px', textAlign: 'center' }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: COLORS.text, fontFamily: FONT_VALUE, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
                <div style={{ fontSize: 9, color: COLORS.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600, marginTop: 2 }}>{label}</div>
              </div>
            ))}
          </div>
        )}

        {/* Empty state */}
        {!loading && cards.length === 0 && (
          <div style={{ textAlign: 'center', padding: '48px 0' }}>
            <div style={{ fontSize: 52, marginBottom: 16 }}>📊</div>
            <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 8 }}>No cards yet</div>
            <div style={{ fontSize: 14, color: COLORS.muted, lineHeight: 1.6, marginBottom: 24 }}>
              Scan your first card to see your portfolio here
            </div>
            <button
              onClick={onGoScan}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 8,
                background: `linear-gradient(135deg, ${COLORS.gold}, ${COLORS.goldDark})`,
                color: '#080808', borderRadius: 14, padding: '14px 24px',
                fontWeight: 700, fontSize: 15, border: 'none', cursor: 'pointer',
              }}
            >
              📸 Scan a Card Now
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// COLLECTION SCREEN
function CollectionScreen({ user, initialGame, onClearFilter }) {
  const [cards, setCards] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filterGame, setFilterGame] = useState(initialGame || 'all')
  const [sortBy, setSortBy] = useState('newest')
  const [dbError, setDbError] = useState('')
  const [currency, setCurrency] = useState(() => localStorage.getItem('gradedex_currency') || 'EUR')

  const fmtVal = (val) => formatCurrency(val, currency)

  useEffect(() => {
    loadCards()
  }, [])

  async function loadCards() {
    setLoading(true)
    setDbError('')
    const { data, error } = await supabase.from('cards').select('*').eq('user_id', user.id).order('created_at', { ascending: false })
    if (error) {
      console.error('loadCards error:', error)
      setDbError(`DB error: ${error.message} (code: ${error.code})`)
    }
    setCards(data || [])
    setLoading(false)
  }

  const filtered = cards
    .filter(c => filterGame === 'all' || c.game === filterGame)
    .filter(c => !search || c.name?.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      if (sortBy === 'newest') return new Date(b.created_at) - new Date(a.created_at)
      if (sortBy === 'grade') return (b.grade || 0) - (a.grade || 0)
      if (sortBy === 'value') return (b.value || 0) - (a.value || 0)
      return 0
    })

  const totalValue = cards.reduce((s, c) => s + (c.value || 0), 0)

  return (
    <div style={{ paddingBottom: 100, maxWidth: 480, margin: '0 auto' }}>

      {/* Search bar at very top */}
      <div style={{ padding: '16px 16px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: COLORS.card, border: `1px solid ${COLORS.border}`, borderRadius: 50, padding: '10px 16px' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={COLORS.muted} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input
            placeholder="Search collection..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ flex: 1, background: 'none', border: 'none', color: COLORS.text, fontSize: 15, outline: 'none', minWidth: 0 }}
          />
          {search && (
            <button onClick={() => setSearch('')} style={{ color: COLORS.muted, fontSize: 18, lineHeight: 1, background: 'none', border: 'none', cursor: 'pointer', padding: 0, flexShrink: 0 }}>×</button>
          )}
          <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: COLORS.muted, flexShrink: 0, display: 'flex', alignItems: 'center', padding: 0 }} aria-label="Favorites">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
          </button>
          <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: COLORS.muted, flexShrink: 0, display: 'flex', alignItems: 'center', padding: 0 }} aria-label="Filter by game">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="12" y1="18" x2="12" y2="18" strokeWidth="3"/></svg>
          </button>
        </div>
      </div>

      {/* Portfolio label + value */}
      <div style={{ padding: '0 16px 16px', textAlign: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, justifyContent: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 13, color: COLORS.muted, fontWeight: 600 }}>Portfolio:</span>
          <span style={{ fontSize: 13, color: COLORS.gold, fontWeight: 800 }}>My Collection</span>
        </div>
        <div style={{ fontSize: 36, fontWeight: 700, fontFamily: FONT_VALUE, letterSpacing: -0.5, fontVariantNumeric: 'tabular-nums' }}>
          {fmtVal(totalValue)}
        </div>
      </div>

      {/* Action buttons row */}
      <div style={{ display: 'flex', justifyContent: 'space-around', padding: '0 16px 20px' }}>
        {[
          {
            label: 'Sort',
            icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={COLORS.text} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="6" y1="12" x2="18" y2="12"/><line x1="9" y1="18" x2="15" y2="18"/></svg>,
            onClick: () => setSortBy(s => s === 'newest' ? 'value' : s === 'value' ? 'grade' : 'newest'),
          },
          {
            label: 'Filter',
            icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={COLORS.text} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>,
            onClick: () => {},
          },
          {
            label: 'Export',
            icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={COLORS.text} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>,
            onClick: () => {},
          },
          {
            label: 'More',
            icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={COLORS.text} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="5" r="1" fill={COLORS.text}/><circle cx="12" cy="12" r="1" fill={COLORS.text}/><circle cx="12" cy="19" r="1" fill={COLORS.text}/></svg>,
            onClick: () => {},
          },
        ].map(({ label, icon, onClick }) => (
          <div key={label} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <button
              onClick={onClick}
              style={{
                width: 52, height: 52, borderRadius: '50%',
                background: COLORS.card, border: `1px solid ${COLORS.border}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer',
              }}
              aria-label={label}
            >
              {icon}
            </button>
            <span style={{ fontSize: 11, color: COLORS.muted, fontWeight: 600 }}>{label}</span>
          </div>
        ))}
      </div>

      <div style={{ padding: '0 16px' }}>
        {/* Game filter pills */}
        <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 8, marginBottom: 10, scrollbarWidth: 'none' }}>
          <button onClick={() => setFilterGame('all')} style={{ flexShrink: 0, padding: '7px 16px', borderRadius: 20, background: filterGame === 'all' ? COLORS.gold : COLORS.card, border: `1.5px solid ${filterGame === 'all' ? COLORS.gold : COLORS.border}`, color: filterGame === 'all' ? '#080808' : COLORS.muted, fontWeight: 700, fontSize: 13 }}>All</button>
          {GAMES.map(g => (
            <button key={g.id} onClick={() => setFilterGame(g.id)} style={{ flexShrink: 0, padding: '7px 14px', borderRadius: 20, background: filterGame === g.id ? g.color + '33' : COLORS.card, border: `1.5px solid ${filterGame === g.id ? g.color : COLORS.border}`, color: filterGame === g.id ? g.color : COLORS.muted, fontWeight: 700, fontSize: 13 }}>
              {g.emoji} {g.label}
            </button>
          ))}
        </div>

        {/* Sort pills */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
          {[['newest', 'Newest'], ['grade', 'Grade'], ['value', 'Value']].map(([val, label]) => (
            <button key={val} onClick={() => setSortBy(val)} style={{ padding: '6px 14px', borderRadius: 20, background: sortBy === val ? COLORS.gold + '22' : 'transparent', border: `1px solid ${sortBy === val ? COLORS.gold : COLORS.border}`, color: sortBy === val ? COLORS.gold : COLORS.muted, fontSize: 13, fontWeight: 600 }}>
              {label}
            </button>
          ))}
        </div>

        {dbError && <div style={{ background: COLORS.danger + '22', border: `1px solid ${COLORS.danger}`, borderRadius: 12, padding: 14, marginBottom: 16, fontSize: 13, color: COLORS.danger }}>{dbError}</div>}

        {loading ? (
          <div style={{ textAlign: 'center', padding: 60 }}><Spinner /></div>
        ) : filtered.length === 0 ? (
          <div className="fadeIn" style={{ textAlign: 'center', padding: '48px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0 }}>
            <div style={{ position: 'relative', width: 80, height: 107, marginBottom: 28 }}>
              <div style={{ position: 'absolute', left: -10, top: 8, width: 70, height: 93, borderRadius: 8, background: COLORS.card, border: `1px solid ${COLORS.border}`, transform: 'rotate(-6deg)' }} />
              <div style={{ position: 'absolute', right: -10, top: 8, width: 70, height: 93, borderRadius: 8, background: COLORS.card, border: `1px solid ${COLORS.border}`, transform: 'rotate(6deg)' }} />
              <div style={{ position: 'absolute', inset: 0, borderRadius: 10, background: COLORS.card, border: `1.5px solid ${COLORS.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32 }}>
                {search || filterGame !== 'all' ? '🔍' : '🃏'}
              </div>
            </div>
            <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 8, color: COLORS.text }}>
              {search ? `No cards match "${search}"` : filterGame !== 'all' ? 'No cards in this game' : 'Your collection is empty'}
            </div>
            <div style={{ fontSize: 14, color: COLORS.muted, lineHeight: 1.6, maxWidth: 260, marginBottom: 24 }}>
              {search || filterGame !== 'all' ? 'Try a different search term or filter' : 'Scan your first card to start your digital collection'}
            </div>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {filtered.map(card => <CardItem key={card.id} card={card} onDelete={loadCards} fmtVal={fmtVal} currency={currency} />)}
          </div>
        )}
      </div>
    </div>
  )
}

function CardItem({ card, onDelete, fmtVal = formatEur, currency = 'EUR' }) {
  const game = GAMES.find(g => g.id === card.game)
  const conditionLabel = getPsaCondition(card.grade)
  const conditionColor = getPsaConditionColor(card.grade)
  const dailyChange = getDailyChange(card.id)
  const changeColor = dailyChange >= 0 ? COLORS.success : COLORS.danger
  const [showDelete, setShowDelete] = useState(false)

  const rate = EXCHANGE_RATES[currency] ?? 1
  const displayValue = card.value ? card.value * rate : null
  const absChange = displayValue ? Math.abs(displayValue * dailyChange / 100) : 0

  function fmtAbs(val) {
    if (!val && val !== 0) return '—'
    return new Intl.NumberFormat('da-DK', { style: 'currency', currency, maximumFractionDigits: 2 }).format(val)
  }

  async function deleteCard() {
    const { error } = await supabase.from('cards').delete().eq('id', card.id).eq('user_id', card.user_id)
    if (!error) onDelete()
  }

  return (
    <div className="fadeIn" style={{ position: 'relative' }}>
      <div style={{ background: COLORS.card, borderRadius: 14, overflow: 'hidden', border: `1px solid ${COLORS.border}`, display: 'flex', flexDirection: 'column' }}>

        {/* Card image */}
        <div style={{ position: 'relative', aspectRatio: '3/4', background: COLORS.bg, overflow: 'hidden' }}>
          {card.image_url ? (
            <img src={card.image_url} alt={card.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8 }}>
              <span style={{ fontSize: 36 }}>{game?.emoji || '🃏'}</span>
              <span style={{ fontSize: 10, color: COLORS.muted, fontWeight: 600, textTransform: 'uppercase' }}>{game?.label || 'Card'}</span>
            </div>
          )}

          {/* Options button */}
          <button
            onClick={() => setShowDelete(v => !v)}
            style={{ position: 'absolute', top: 8, left: 8, width: 26, height: 26, borderRadius: 7, background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, border: 'none', cursor: 'pointer', color: '#fff', letterSpacing: 1 }}
            aria-label="Card options"
          >
            ···
          </button>

          {showDelete && (
            <div className="fadeIn" style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.78)', backdropFilter: 'blur(4px)', display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center', justifyContent: 'center' }}>
              <button onClick={deleteCard} style={{ background: COLORS.danger, color: '#fff', borderRadius: 10, padding: '10px 22px', fontWeight: 700, fontSize: 13, border: 'none', cursor: 'pointer' }}>Delete</button>
              <button onClick={() => setShowDelete(false)} style={{ color: COLORS.muted, fontSize: 13, background: 'none', border: 'none', cursor: 'pointer' }}>Cancel</button>
            </div>
          )}
        </div>

        {/* Info section */}
        <div style={{ padding: '10px 10px 11px', display: 'flex', flexDirection: 'column', gap: 3 }}>

          {/* Card name — large + bold */}
          <div style={{ fontWeight: 800, fontSize: 13, lineHeight: 1.25, letterSpacing: -0.2, color: COLORS.text, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
            {card.name || 'Unknown Card'}
          </div>

          {/* Set name or game label */}
          <div style={{ fontSize: 10, color: COLORS.muted, fontWeight: 500, letterSpacing: 0.1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {card.set_name || game?.label || 'Trading Card'}
          </div>

          {/* Finish + card number */}
          <div style={{ fontSize: 10, color: COLORS.muted, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {[card.finish, card.card_number].filter(Boolean).join(' • ') || '—'}
          </div>

          {/* Condition */}
          <div style={{ fontSize: 10, fontWeight: 700, color: conditionColor, letterSpacing: 0.1 }}>
            {conditionLabel || 'Near Mint'}
          </div>

          {/* Divider */}
          <div style={{ height: 1, background: 'rgba(255,255,255,0.055)', margin: '3px 0' }} />

          {/* Value + Qty */}
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 4 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 2, minWidth: 0, flex: 1 }}>
              <span style={{ fontSize: 10, color: changeColor, fontWeight: 800, lineHeight: 1, flexShrink: 0 }}>
                {dailyChange >= 0 ? '▲' : '▼'}
              </span>
              <span style={{ fontWeight: 700, fontSize: 13, color: COLORS.text, fontFamily: FONT_VALUE, letterSpacing: -0.3, fontVariantNumeric: 'tabular-nums', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {displayValue ? fmtAbs(displayValue) : '—'}
              </span>
            </div>
            <span style={{ fontSize: 10, color: COLORS.muted, fontWeight: 600, flexShrink: 0 }}>Qty: 1</span>
          </div>

          {/* Absolute change + % */}
          <div style={{ fontSize: 10, fontWeight: 600, color: changeColor, fontFamily: FONT_VALUE, fontVariantNumeric: 'tabular-nums' }}>
            {displayValue
              ? `${dailyChange >= 0 ? '+' : '-'}${fmtAbs(absChange)} (${dailyChange >= 0 ? '+' : ''}${dailyChange.toFixed(2)}%)`
              : <span style={{ color: COLORS.muted }}>No value set</span>
            }
          </div>

        </div>
      </div>
    </div>
  )
}

// SETTINGS SCREEN
function SettingsScreen({ user, profile, onSignOut }) {
  const [profileTab, setProfileTab] = useState('stats')
  const [loading, setLoading] = useState(false)
  const [cardCount, setCardCount] = useState(null)
  const [totalValue, setTotalValue] = useState(null)

  useEffect(() => {
    supabase.from('cards').select('value').eq('user_id', user.id).then(({ data }) => {
      if (data) {
        setCardCount(data.length)
        setTotalValue(data.reduce((s, c) => s + (c.value || 0), 0))
      }
    })
  }, [])

  async function signOut() {
    setLoading(true)
    await supabase.auth.signOut()
    onSignOut()
  }

  const initial = user.email?.[0]?.toUpperCase() || '?'
  const username = user.email?.split('@')[0] || ''

  return (
    <div style={{ paddingBottom: 100, maxWidth: 480, margin: '0 auto' }}>

      {/* Top right flag + currency */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '16px 16px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: COLORS.card, border: `1px solid ${COLORS.border}`, borderRadius: 20, padding: '6px 12px' }}>
          <span style={{ fontSize: 16 }}>🇪🇺</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: COLORS.text }}>EUR</span>
        </div>
      </div>

      {/* Avatar + username + email */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '20px 16px 20px', gap: 8 }}>
        <div style={{
          width: 72, height: 72, borderRadius: '50%', flexShrink: 0,
          background: `linear-gradient(135deg, ${COLORS.gold}, ${COLORS.goldDark})`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 28, fontWeight: 900, color: '#080808',
          boxShadow: `0 0 0 3px ${COLORS.border}, 0 0 0 5px ${COLORS.gold}44`,
        }}>
          {initial}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontWeight: 900, fontSize: 20 }}>{username}</span>
          <span style={{ width: 20, height: 20, borderRadius: '50%', background: COLORS.success, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: '#fff', fontWeight: 900 }}>✓</span>
        </div>
        <div style={{ fontSize: 13, color: COLORS.muted }}>{user.email}</div>
      </div>

      {/* 4-column stats bar */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', padding: '0 16px', marginBottom: 16 }}>
        {[
          ['Total Cards', profile?.card_count ?? cardCount ?? 0],
          ['Sealed', 0],
          ['Graded', 0],
          ['Total Value', totalValue !== null ? formatEur(totalValue) : '—'],
        ].map(([label, val]) => (
          <div key={label} style={{ textAlign: 'center', padding: '12px 0' }}>
            <div style={{ fontSize: 18, fontWeight: 900, color: COLORS.text, fontVariantNumeric: 'tabular-nums', marginBottom: 2 }}>{val}</div>
            <div style={{ fontSize: 10, color: COLORS.muted, fontWeight: 600, lineHeight: 1.3 }}>{label}</div>
          </div>
        ))}
      </div>

      {/* Two full-width action buttons */}
      <div style={{ display: 'flex', gap: 10, padding: '0 16px', marginBottom: 20 }}>
        <button style={{ flex: 1, padding: '13px 0', borderRadius: 12, background: 'transparent', border: `1.5px solid ${COLORS.border}`, color: COLORS.text, fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>
          Social Profile
        </button>
        <button style={{ flex: 1, padding: '13px 0', borderRadius: 12, background: 'transparent', border: `1.5px solid ${COLORS.border}`, color: COLORS.text, fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>
          Edit
        </button>
      </div>

      {/* Tab selector */}
      <div style={{ display: 'flex', margin: '0 16px 20px', background: COLORS.bg, borderRadius: 14, padding: 4, border: `1px solid ${COLORS.border}` }}>
        {[['stats', 'Stats'], ['settings', 'Settings'], ['support', 'Support']].map(([id, label]) => (
          <button key={id} onClick={() => setProfileTab(id)} style={{
            flex: 1, padding: '10px 0', borderRadius: 10, fontWeight: 700, fontSize: 13,
            background: profileTab === id ? COLORS.card : 'transparent',
            color: profileTab === id ? COLORS.text : COLORS.muted,
            border: 'none', cursor: 'pointer',
            transition: 'all .2s',
          }}>
            {label}
          </button>
        ))}
      </div>

      {/* Stats tab */}
      {profileTab === 'stats' && (
        <div style={{ padding: '0 16px' }}>
          <Card style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 14 }}>
              <span style={{ fontSize: 13, color: COLORS.muted, fontWeight: 600 }}>Portfolio</span>
              <span style={{ fontSize: 13, color: COLORS.gold, fontWeight: 800 }}>My Collection</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-around', textAlign: 'center' }}>
              {[
                ['Cards', profile?.card_count ?? cardCount ?? 0],
                ['Graded', 0],
                ['Value', totalValue !== null ? formatEur(totalValue) : '—'],
              ].map(([label, val]) => (
                <div key={label}>
                  <div style={{ fontSize: 22, fontWeight: 900, color: COLORS.gold, fontVariantNumeric: 'tabular-nums' }}>{val}</div>
                  <div style={{ fontSize: 11, color: COLORS.muted, marginTop: 4 }}>{label}</div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {/* Settings tab */}
      {profileTab === 'settings' && (
        <div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {!profile?.is_pro && (
            <Card style={{ background: `linear-gradient(135deg, ${COLORS.gold}11, ${COLORS.goldDark}11)`, border: `1px solid ${COLORS.gold}44` }}>
              <div style={{ fontWeight: 900, fontSize: 18, marginBottom: 6 }}>Upgrade to Pro</div>
              <div style={{ color: COLORS.muted, fontSize: 14, marginBottom: 16, lineHeight: 1.6 }}>
                30 AI scans/day · Unlimited collection · Priority support
              </div>
              <div style={{ marginBottom: 14 }}>
                <span style={{ fontSize: 28, fontWeight: 900, color: COLORS.gold }}>4.99€</span>
                <span style={{ color: COLORS.muted, fontSize: 14 }}> /month</span>
              </div>
              <Btn onClick={() => window.open(STRIPE_URL, '_blank')}>Buy Pro Now</Btn>
            </Card>
          )}
          <Btn onClick={signOut} variant="danger" disabled={loading}>
            {loading ? <Spinner size={18} color={COLORS.danger} /> : 'Sign Out'}
          </Btn>
        </div>
      )}

      {/* Support tab */}
      {profileTab === 'support' && (
        <div style={{ padding: '0 16px' }}>
          <Card>
            {[['Privacy Policy', '/privacy.html'], ['Terms of Service', '/terms.html']].map(([label, href], i, arr) => (
              <a key={href} href={href} target="_blank" rel="noreferrer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 0', borderBottom: i < arr.length - 1 ? `1px solid ${COLORS.border}` : 'none', color: COLORS.text, textDecoration: 'none', fontSize: 15 }}>
                {label} <span style={{ color: COLORS.muted }}>→</span>
              </a>
            ))}
            <div style={{ padding: '14px 0 0', color: COLORS.muted, fontSize: 13 }}>Version 1.0.0 · GradeDex EU</div>
          </Card>
        </div>
      )}
    </div>
  )
}

const GAME_LOGOS = {
  pokemon:    '/logos/pokemon.svg',
  mtg:        '/logos/mtg.png',
  yugioh:     '/logos/yugioh.svg',
  onepiece:   '/logos/onepiece.png',
  dragonball: '/logos/dragonball.png',
  lorcana:    '/logos/lorcana.png',
}

// SEARCH SCREEN
function SearchScreen({ onSelectGame }) {
  const [query, setQuery] = useState('')
  const [imgErrors, setImgErrors] = useState({})

  return (
    <div style={{ paddingBottom: 110, maxWidth: 480, margin: '0 auto' }}>
      {/* Search bar */}
      <div style={{ padding: '16px 16px 0' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          background: COLORS.card, borderRadius: 50,
          border: `1px solid ${COLORS.border}`, padding: '0 16px', height: 48,
        }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={COLORS.muted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search for cards..."
            style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: COLORS.text, fontSize: 15 }}
          />
          {query ? (
            <button onClick={() => setQuery('')} style={{ background: 'none', border: 'none', color: COLORS.muted, fontSize: 18, cursor: 'pointer', padding: 0, lineHeight: 1 }}>✕</button>
          ) : (
            <>
              <div style={{ width: 1, height: 20, background: COLORS.border }} />
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={COLORS.muted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={COLORS.muted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="11" y1="18" x2="13" y2="18"/></svg>
            </>
          )}
        </div>
      </div>

      {/* Quick Filters */}
      <div style={{ padding: '28px 16px 0' }}>
        <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 16 }}>Quick Filters</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {GAMES.map(game => {
            const logoUrl = GAME_LOGOS[game.id]
            const hasLogo = logoUrl && !imgErrors[game.id]
            return (
              <button
                key={game.id}
                onClick={() => onSelectGame(game.id)}
                style={{
                  background: `radial-gradient(ellipse at 30% 30%, ${game.color}25 0%, #111 65%)`,
                  border: `1px solid ${game.color}40`,
                  borderRadius: 16,
                  height: 110,
                  display: 'flex', flexDirection: 'column',
                  alignItems: 'center', justifyContent: 'center',
                  gap: 8, cursor: 'pointer',
                  position: 'relative', overflow: 'hidden',
                  padding: '14px 12px 10px',
                }}
              >
                <div style={{ width: '100%', height: 56, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {hasLogo ? (
                    <img
                      src={logoUrl}
                      alt={game.label}
                      referrerPolicy="no-referrer"
                      onError={() => setImgErrors(e => ({ ...e, [game.id]: true }))}
                      style={{
                        maxWidth: game.id === 'dragonball' ? '96%' : '88%',
                        maxHeight: game.id === 'dragonball' ? 62 : 54,
                        width: 'auto', height: 'auto', objectFit: 'contain',
                      }}
                    />
                  ) : (
                    <span style={{ fontSize: 34, lineHeight: 1 }}>{game.emoji}</span>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// BOTTOM NAV
function BottomNav({ tab, setTab }) {
  const sw = 1.6
  const ic = (a) => a ? COLORS.gold : COLORS.muted

  const tabs = [
    {
      id: 'home', label: 'Home',
      icon: (a) => (
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke={ic(a)} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 10.5L12 3l9 7.5V20a1 1 0 01-1 1H5a1 1 0 01-1-1v-9.5z"/>
          <polyline points="9,21 9,13 15,13 15,21"/>
        </svg>
      )
    },
    {
      id: 'search', label: 'Search',
      icon: (a) => (
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke={ic(a)} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="7.5"/>
          <line x1="20.5" y1="20.5" x2="16.2" y2="16.2"/>
        </svg>
      )
    },
    {
      id: 'scan', label: 'Ai Grade',
      icon: (a) => (
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke={ic(a)} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/>
        </svg>
      )
    },
    {
      id: 'collection', label: 'Collection',
      icon: (a) => (
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke={ic(a)} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="7" width="20" height="14" rx="2"/>
          <path d="M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2"/>
        </svg>
      )
    },
    {
      id: 'settings', label: 'Profile',
      icon: (a) => (
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke={ic(a)} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/>
          <circle cx="12" cy="7" r="4"/>
        </svg>
      )
    },
  ]

  return (
    <div style={{
      position: 'fixed',
      bottom: `calc(14px + env(safe-area-inset-bottom))`,
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: 100,
      background: 'rgba(10,10,16,0.96)',
      borderRadius: 24,
      border: `1px solid rgba(212,175,55,0.12)`,
      display: 'flex',
      alignItems: 'center',
      padding: '3px',
      backdropFilter: 'blur(32px)',
      WebkitBackdropFilter: 'blur(32px)',
      boxShadow: '0 8px 40px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.04)',
      whiteSpace: 'nowrap',
    }}>
      {tabs.map(t => {
        const isActive = tab === t.id
        return (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            aria-label={t.label}
            aria-current={isActive ? 'page' : undefined}
            style={{
              display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center',
              gap: 2,
              padding: '6px 13px 5px',
              borderRadius: 20,
              background: isActive ? `rgba(212,175,55,0.12)` : 'transparent',
              boxShadow: isActive ? '0 0 12px rgba(212,175,55,0.28)' : 'none',
              border: 'none',
              cursor: 'pointer',
              transition: 'background 0.18s ease, box-shadow 0.18s ease',
            }}
          >
            {t.icon(isActive)}
            <span style={{
              fontSize: 9,
              fontWeight: isActive ? 700 : 400,
              color: isActive ? COLORS.gold : COLORS.muted,
              letterSpacing: 0.1,
              transition: 'color 0.18s',
              lineHeight: 1,
            }}>
              {t.label}
            </span>
          </button>
        )
      })}
    </div>
  )
}

// ERROR BOUNDARY
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { hasError: false, error: null } }
  static getDerivedStateFromError(error) { return { hasError: true, error } }
  render() {
    if (this.state.hasError) return (
      <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 32, textAlign: 'center', background: COLORS.bg, color: COLORS.text }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
        <h2 style={{ marginBottom: 8 }}>Something went wrong</h2>
        <p style={{ color: COLORS.muted, marginBottom: 24, fontSize: 14 }}>{this.state.error?.message}</p>
        <button onClick={() => window.location.reload()} style={{ padding: '14px 28px', background: COLORS.gold, color: '#0a0a12', borderRadius: 14, fontWeight: 700, fontSize: 16 }}>Reload App</button>
      </div>
    )
    return this.props.children
  }
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [tab, setTab] = useState('home')
  const [searchGameFilter, setSearchGameFilter] = useState(null)
  const [onboarded, setOnboarded] = useState(() => localStorage.getItem('gd_onboarded') === '1')
  const [loading, setLoading] = useState(true)
  const [splashDone, setSplashDone] = useState(false)
  const [splashFading, setSplashFading] = useState(false)
  const [modelState, setModelState] = useState('idle') // idle | loading | ready | error
  const [modelProgress, setModelProgress] = useState(0)

  useEffect(() => {
    // Inject global styles
    const style = document.createElement('style')
    style.textContent = globalStyle
    document.head.appendChild(style)

    // Hand off from HTML splash to React splash seamlessly
    const htmlSplash = document.getElementById('splash')
    if (htmlSplash) {
      htmlSplash.classList.add('hidden')
      setTimeout(() => htmlSplash.remove(), 400)
    }

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSession(sess)
      if (sess) loadProfile(sess.user.id)
      else { setProfile(null); setLoading(false) }
    })

    return () => subscription.unsubscribe()
  }, [])

  async function loadProfile(userId) {
    const today = new Date().toISOString().slice(0, 10)
    const [{ data }, { count: dailyCount }, { count: cardCount }] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', userId).single(),
      supabase.from('scan_logs').select('*', { count: 'exact', head: true }).eq('user_id', userId).eq('scan_date', today),
      supabase.from('cards').select('*', { count: 'exact', head: true }).eq('user_id', userId),
    ])
    setProfile({ ...(data || {}), daily_scans: dailyCount || 0, card_count: cardCount || 0 })
    setLoading(false)
  }

  function handleOnboarded() {
    localStorage.setItem('gd_onboarded', '1')
    setOnboarded(true)
  }

  function handleAuth(sess) {
    setSession(sess)
    if (sess) loadProfile(sess.user.id)
  }

  useEffect(() => {
    const minTimer = setTimeout(() => setSplashDone(true), 1800)
    return () => clearTimeout(minTimer)
  }, [])

  // Preload CLIP model in background after login — ready before first scan
  useEffect(() => {
    if (!session) return
    let cancelled = false
    async function preload() {
      try {
        setModelState('loading')
        const { loadEmbeddingModel } = await import('./recognition/EmbeddingExtractor.js')
        await loadEmbeddingModel(({ status, progress }) => {
          if (cancelled) return
          if (status === 'progress' && typeof progress === 'number') {
            setModelProgress(Math.round(progress))
          }
        })
        if (!cancelled) setModelState('ready')
      } catch {
        if (!cancelled) setModelState('error')
      }
    }
    preload()
    return () => { cancelled = true }
  }, [session])

  const showSplash = loading || !splashDone

  useEffect(() => {
    if (!loading && splashDone && !splashFading) {
      setSplashFading(true)
    }
  }, [loading, splashDone])

  if (showSplash || splashFading) return (
    <div style={{
      height: '100dvh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      background: COLORS.bg, position: 'relative', overflow: 'hidden',
      animation: splashFading ? 'fadeOut .4s ease both' : 'none',
    }}
      onAnimationEnd={() => setSplashFading(false)}
    >
      {/* Baggrundsglow */}
      <div style={{
        position: 'absolute', width: 320, height: 320, borderRadius: '50%',
        background: `radial-gradient(circle, ${COLORS.gold}18 0%, transparent 70%)`,
        animation: 'glowPulse 2.5s ease-in-out infinite',
        pointerEvents: 'none',
      }} />

      {/* Logo med splash-animation */}
      <div style={{ animation: 'splashEntrance .7s cubic-bezier(.34,1.4,.64,1) both', position: 'relative', zIndex: 1 }}>
        <GradeDexLogo size="lg" />
      </div>

      {/* Shimmer-bar */}
      <div style={{
        position: 'absolute', bottom: 60, width: 140, height: 2,
        background: COLORS.border, borderRadius: 2, overflow: 'hidden',
      }}>
        <div style={{
          width: '35%', height: '100%', borderRadius: 2,
          background: `linear-gradient(to right, transparent, ${COLORS.gold}, transparent)`,
          animation: 'sweepBar 1.4s ease-in-out infinite',
        }} />
      </div>
    </div>
  )

  if (!onboarded) return <Onboarding onDone={handleOnboarded} />
  if (!session) return <AuthScreen onAuth={handleAuth} />

  return (
    <ErrorBoundary>
      <div style={{ background: COLORS.bg, minHeight: '100dvh' }}>
        {tab === 'home'       && <HomeScreen user={session.user} profile={profile} onGoScan={() => setTab('scan')} onViewAll={() => setTab('collection')} />}
        {tab === 'search'     && <SearchScreen onSelectGame={gameId => { setSearchGameFilter(gameId); setTab('collection') }} />}
        {tab === 'scan'       && <ScanScreen user={session.user} profile={profile} onScanDone={() => loadProfile(session.user.id)} modelState={modelState} modelProgress={modelProgress} />}
        {tab === 'collection' && <CollectionScreen user={session.user} initialGame={searchGameFilter} onClearFilter={() => setSearchGameFilter(null)} />}
        {tab === 'settings'   && <SettingsScreen user={session.user} profile={profile} onSignOut={() => setSession(null)} />}
        <BottomNav tab={tab} setTab={setTab} />
      </div>
    </ErrorBoundary>
  )
}
