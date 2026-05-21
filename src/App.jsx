import React, { useState, useEffect, useRef, useCallback, createContext, useContext } from 'react'
import { createClient } from '@supabase/supabase-js'

// ─── Supabase ────────────────────────────────────────────────────────────────
const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
)

// ─── Constants ───────────────────────────────────────────────────────────────
const GAMES = [
  { id: 'pokemon',    label: 'Pokémon',        emoji: '⚡', color: '#FFCB05' },
  { id: 'mtg',        label: 'Magic: TG',      emoji: '🔮', color: '#a29bfe' },
  { id: 'yugioh',     label: 'Yu-Gi-Oh!',      emoji: '👁', color: '#fdcb6e' },
  { id: 'onepiece',   label: 'One Piece',      emoji: '☠️', color: '#e17055' },
  { id: 'dragonball', label: 'Dragon Ball',    emoji: '🐉', color: '#f39c12' },
  { id: 'lorcana',    label: 'Lorcana',        emoji: '✨', color: '#74b9ff' },
]

const STRIPE_URL = 'https://buy.stripe.com/REPLACE_WITH_YOUR_STRIPE_LINK'

const COLORS = {
  bg: '#080808',
  card: '#101010',
  border: '#1c1c1c',
  gold: '#F5B429',
  goldDark: '#C87800',
  goldLight: '#FFD966',
  text: '#ffffff',
  muted: '#707080',
  danger: '#e74c3c',
  success: '#00b894',
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
        <span style={{ fontSize: 30 * s, fontWeight: 900, color: COLORS.gold, letterSpacing: -0.5, lineHeight: 1 }}>Dex</span>
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

// ─── Styles ───────────────────────────────────────────────────────────────────
const globalStyle = `
  * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
  html, body, #root { height: 100%; width: 100%; }
  body {
    background: ${COLORS.bg};
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
    primary: { background: `linear-gradient(135deg, ${COLORS.gold}, ${COLORS.goldDark})`, color: '#0a0a12' },
    ghost: { background: 'transparent', border: `1.5px solid ${COLORS.border}`, color: COLORS.text },
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
    <div style={{ background: COLORS.card, borderRadius: 20, padding: 20, border: `1px solid ${COLORS.border}`, ...style }}>
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
    title: 'Scan dit kort',
    desc: 'Tag et billede — AI giver dig et PSA-gradéringsestimat på sekunder.',
    detail: 'Støtter Pokémon, MTG, Yu-Gi-Oh! og mere',
    accent: COLORS.gold,
  },
  {
    emoji: '💰',
    title: 'EUR-priser live',
    desc: 'Cardmarket-priser i euro direkte i appen.',
    detail: 'Se om gradering er en god investering',
    accent: COLORS.success,
  },
  {
    emoji: '🗂️',
    title: 'Din digitale samling',
    desc: 'Byg og track din samling på tværs af 6 TCG-spil.',
    detail: 'Se den samlede porteføljeværdi i ét overblik',
    accent: '#74b9ff',
  },
  {
    emoji: '🔒',
    title: 'GDPR-sikker i EU',
    desc: 'Dine data gemmes i EU. Ingen reklamer. Du ejer dine data.',
    detail: 'Start gratis — opgrader når du er klar',
    accent: COLORS.gold,
    cta: true,
  },
]

function Onboarding({ onDone }) {
  const [idx, setIdx] = useState(0)
  const slide = SLIDES[idx]

  return (
    <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', background: COLORS.bg, overflow: 'hidden' }}>

      {/* Header: logo + skip */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '24px 24px 0' }}>
        <GradeDexLogo size="sm" />
        {idx < SLIDES.length - 1 && (
          <button onClick={onDone} style={{ color: COLORS.muted, fontSize: 13, fontWeight: 600, padding: '6px 12px', background: COLORS.card, borderRadius: 8, border: `1px solid ${COLORS.border}` }}>
            Spring over
          </button>
        )}
      </div>

      {/* Slide-indhold */}
      <div key={idx} className="slideUp" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '0 32px', textAlign: 'center' }}>
        <div style={{
          width: 110, height: 110, borderRadius: '50%',
          background: slide.accent + '18',
          border: `1.5px solid ${slide.accent}40`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 52, marginBottom: 28,
          boxShadow: `0 0 50px ${slide.accent}25`,
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
        <div style={{ width: '100%', maxWidth: 360 }}>
          {slide.cta ? (
            <Btn onClick={onDone}>Kom i gang gratis</Btn>
          ) : (
            <Btn onClick={() => setIdx(i => i + 1)} style={{ background: `linear-gradient(135deg, ${slide.accent}, ${slide.accent}cc)` }}>
              Næste
            </Btn>
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
    if (mode === 'signup' && !gdprOk) { setError('Acceptér privatlivspolitikken for at fortsætte.'); return }
    setLoading(true); setError('')
    try {
      const fn = mode === 'login' ? supabase.auth.signInWithPassword : supabase.auth.signUp
      const { data, error: err } = await fn.call(supabase.auth, { email, password })
      if (err) throw err
      if (mode === 'signup' && !data.session) {
        setError('Tjek din e-mail for et bekræftelseslink.')
        setLoading(false); return
      }
      onAuth(data.session)
    } catch (err) {
      setError(err.message || 'Noget gik galt')
      setLoading(false)
    }
  }

  const inp = { background: COLORS.border, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: '14px 16px', color: COLORS.text, fontSize: 16, width: '100%', outline: 'none' }

  return (
    <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div className="fadeIn" style={{ width: '100%', maxWidth: 380, display: 'flex', flexDirection: 'column', gap: 24 }}>
        <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <GradeDexLogo size="md" />
          <p style={{ color: COLORS.muted, fontSize: 14, marginTop: 4 }}>{mode === 'login' ? 'Log ind på din konto' : 'Opret gratis konto'}</p>
        </div>
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input style={inp} type="email" placeholder="E-mail" value={email} onChange={e => setEmail(e.target.value)} required />
          <input style={inp} type="password" placeholder="Adgangskode" value={password} onChange={e => setPassword(e.target.value)} required minLength={6} />
          {mode === 'signup' && (
            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer', color: COLORS.muted, fontSize: 13 }}>
              <input type="checkbox" checked={gdprOk} onChange={e => setGdprOk(e.target.checked)} style={{ marginTop: 2 }} />
              <span>Jeg accepterer <a href="/privacy.html" target="_blank" style={{ color: COLORS.gold }}>privatlivspolitikken</a> og <a href="/terms.html" target="_blank" style={{ color: COLORS.gold }}>vilkårene</a></span>
            </label>
          )}
          {error && <p style={{ color: COLORS.danger, fontSize: 13, textAlign: 'center' }}>{error}</p>}
          <Btn disabled={loading}>{loading ? <Spinner size={18} color="#0a0a12" /> : mode === 'login' ? 'Log ind' : 'Opret konto'}</Btn>
        </form>
        <button onClick={() => { setMode(m => m === 'login' ? 'signup' : 'login'); setError('') }} style={{ color: COLORS.muted, fontSize: 14, textAlign: 'center' }}>
          {mode === 'login' ? 'Ingen konto? Opret gratis →' : 'Har du allerede en konto? Log ind'}
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
    async function start() {
      try {
        let stream
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: 'environment' } } })
        } catch {
          stream = await navigator.mediaDevices.getUserMedia({ video: true })
        }
        streamRef.current = stream
        videoRef.current.srcObject = stream
        videoRef.current.play()
        setReady(true)
      } catch {
        setErr('Kunne ikke åbne kamera. Tillad kameraadgang i browseren.')
      }
    }
    start()
    return () => streamRef.current?.getTracks().forEach(t => t.stop())
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
          {/* Mørklagt ydre */}
          <div style={{ position: 'absolute', inset: 0, background: '#0007' }} />
          {/* Kortramme — 3:4 aspekt */}
          <div style={{ position: 'relative', width: '62vw', aspectRatio: '3/4', maxWidth: 220 }}>
            {/* Hjørnemarkeringer */}
            {[['topleft', {top:0,left:0}], ['topright', {top:0,right:0}], ['bottomleft', {bottom:0,left:0}], ['bottomright', {bottom:0,right:0}]].map(([pos, s]) => (
              <div key={pos} style={{ position: 'absolute', width: 24, height: 24, ...s }}>
                <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: 3, background: COLORS.gold }} />
                <div style={{ position: 'absolute', top: 0, left: 0, width: 3, height: '100%', background: COLORS.gold }} />
              </div>
            ))}
            {/* Gennemsigtigt vindue */}
            <div style={{ position: 'absolute', inset: 0, background: 'transparent', border: 'none' }} />
          </div>
          <div style={{ marginTop: 16, fontSize: 13, color: '#ffffffaa', fontWeight: 600, letterSpacing: 0.3 }}>
            {ready ? 'Placer kortets forside i rammen' : 'Starter kamera…'}
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
        <button onClick={onClose} style={{ color: '#ffffffcc', fontSize: 15, padding: 12, minWidth: 80, fontWeight: 600 }}>Annuller</button>

        {/* Lukker-knap */}
        <button
          onClick={capture}
          disabled={!ready}
          aria-label="Tag billede"
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
function ScanScreen({ user, profile, onScanDone }) {
  const [game, setGame] = useState('pokemon')
  const [frontImg, setFrontImg] = useState(null)
  const [backImg, setBackImg] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const [camera, setCamera] = useState(null) // 'front' | 'back' | null
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

  async function analyze() {
    if (!frontImg) { setError('Upload forsiden af kortet først'); return }
    setLoading(true); setError('')
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      if (!token) { setError('Ikke logget ind — genindlæs appen'); setLoading(false); return }
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ frontImage: frontImg, backImage: backImg, game })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Analyse fejlede')
      const raw = data.analysis
      const start = raw.indexOf('{')
      const end = raw.lastIndexOf('}')
      const parsed = JSON.parse(raw.slice(start, end + 1))
      setResult({ ...parsed, officialImageUrl: data.officialImageUrl || null })
      onScanDone()
    } catch (err) {
      setError(err.message)
    }
    setLoading(false)
  }

  const scansLeft = profile?.is_pro ? `${30 - (profile?.daily_scans || 0)} i dag` : `${3 - (profile?.total_scans || 0)} gratis tilbage`

  return (
    <div style={{ padding: '16px 16px 100px', maxWidth: 480, margin: '0 auto' }}>
      {camera && <CameraModal onCapture={handleCameraCapture} onClose={() => setCamera(null)} />}
      <input ref={frontRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={e => handleFile(e, 'front')} />
      <input ref={backRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={e => handleFile(e, 'back')} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, paddingTop: 8 }}>
        <h2 style={{ fontWeight: 900, fontSize: 22 }}>AI Kortanalyse</h2>
        <Badge color={profile?.is_pro ? COLORS.gold : COLORS.muted}>{profile?.is_pro ? 'PRO' : scansLeft}</Badge>
      </div>

      {/* Game selector */}
      <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 8, marginBottom: 20, scrollbarWidth: 'none' }}>
        {GAMES.map(g => (
          <button key={g.id} onClick={() => setGame(g.id)} style={{
            flexShrink: 0, padding: '8px 14px', borderRadius: 12,
            background: game === g.id ? g.color + '33' : COLORS.card,
            border: `1.5px solid ${game === g.id ? g.color : COLORS.border}`,
            color: game === g.id ? g.color : COLORS.muted,
            fontWeight: 700, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6,
          }}>
            {g.emoji} {g.label}
          </button>
        ))}
      </div>

      {/* Image upload */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
        {[{ label: 'Forside', key: 'front', img: frontImg }, { label: 'Bagside (valgfri)', key: 'back', img: backImg }].map(({ label, key, img }) => (
          <button key={key} onClick={() => pickImage(key)} style={{
            aspectRatio: '3/4', borderRadius: 16, border: `2px dashed ${img ? COLORS.gold : COLORS.border}`,
            background: COLORS.card, overflow: 'hidden', position: 'relative',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8,
          }}>
            {img ? (
              <img src={img} alt={label} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : (
              <>
                <span style={{ fontSize: 32 }}>📷</span>
                <span style={{ color: COLORS.muted, fontSize: 12, fontWeight: 600 }}>{label}</span>
              </>
            )}
          </button>
        ))}
      </div>

      {error && <p style={{ color: COLORS.danger, fontSize: 13, marginBottom: 12, textAlign: 'center' }}>{error}</p>}

      <Btn onClick={analyze} disabled={loading || !frontImg}>
        {loading ? <><Spinner size={18} color="#0a0a12" /> Analyserer...</> : '🔍 Analysér kort'}
      </Btn>

      {/* Result */}
      {result && <GradeResult result={result} game={game} frontImg={frontImg} user={user} onSave={() => { setResult(null); setFrontImg(null); setBackImg(null); onScanDone() }} />}
    </div>
  )
}

function GradeResult({ result, game, frontImg, user, onSave }) {
  const gradeColor = result.estimatedGrade >= 9 ? COLORS.success : result.estimatedGrade >= 7 ? COLORS.gold : result.estimatedGrade >= 5 ? '#e67e22' : COLORS.danger
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState('')

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

    // Parse prisinterval — tag gennemsnittet af "40-65€" → 52
    const valueStr = result.estimatedPSAValue || ''
    const nums = [...valueStr.matchAll(/\d+/g)].map(m => parseFloat(m[0]))
    const valueNum = nums.length >= 2 ? (nums[0] + nums[1]) / 2 : nums[0] || null

    const { error } = await supabase.from('cards').insert({
      user_id: user.id,
      name: result.cardName || result.name || result.kortNavn || null,
      game,
      grade: result.estimatedGrade,
      value: valueNum,
      price_range: result.estimatedPSAValue || null,
      image_url: result.officialImageUrl || imageUrl,
      notes: result.recommendation,
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
      navigator.share({ title: 'GradeDex Analyse', text: `PSA ${result.estimatedGrade} estimat — ${result.recommendation}`, url: window.location.href })
    }
  }

  const gradeBg = result.estimatedGrade >= 9
    ? `linear-gradient(135deg, ${COLORS.success}22, ${COLORS.success}08)`
    : result.estimatedGrade >= 7
      ? `linear-gradient(135deg, ${COLORS.gold}22, ${COLORS.gold}08)`
      : result.estimatedGrade >= 5
        ? 'linear-gradient(135deg, #e67e2222, #e67e2208)'
        : `linear-gradient(135deg, ${COLORS.danger}22, ${COLORS.danger}08)`
  const confidenceColor = result.confidence === 'Høj' ? COLORS.success : result.confidence === 'Middel' ? COLORS.gold : COLORS.muted

  const subGradeScore = (text) => {
    if (!text) return null
    const lower = text.toLowerCase()
    if (lower.includes('perfekt') || lower.includes('excellent') || lower.includes('ingen')) return 10
    if (lower.includes('minimal') || lower.includes('svag')) return 7
    if (lower.includes('moderat') || lower.includes('nogen')) return 5
    return null
  }

  const subGrades = [
    ['Centrering', result.centering],
    ['Hjørner', result.corners],
    ['Kanter', result.edges],
    ['Overflade', result.surface],
  ]

  return (
    <Card style={{ marginTop: 20, padding: 0, overflow: 'hidden' }} className="slideUp">
      {/* Hero header med kort-billede og grade-cirkel side om side */}
      <div style={{ background: gradeBg, padding: '20px 20px 0', borderBottom: `1px solid ${COLORS.border}` }}>
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', marginBottom: 20 }}>
          {/* Kortbillede */}
          {(result.officialImageUrl || frontImg) && (
            <div style={{ position: 'relative', flexShrink: 0 }}>
              <img
                src={result.officialImageUrl || frontImg}
                alt="kort"
                style={{ width: 72, aspectRatio: '3/4', objectFit: 'cover', borderRadius: 10, boxShadow: '0 4px 20px #0008' }}
              />
              {result.officialImageUrl && (
                <div style={{ position: 'absolute', bottom: 4, right: 4, background: COLORS.success, borderRadius: 4, width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10 }}>✓</div>
              )}
            </div>
          )}

          {/* Kortnavn + grade */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: COLORS.muted, marginBottom: 2, textTransform: 'uppercase', letterSpacing: 0.8, fontWeight: 600 }}>AI Analyseresultat</div>
            <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 12, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {result.cardName || 'Ukendt kort'}
            </div>

            {/* Grade badge — stor og tydelig */}
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <div className="gradeReveal" style={{ fontSize: 64, fontWeight: 900, color: gradeColor, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
                {result.estimatedGrade}
              </div>
              <div>
                <div style={{ fontSize: 11, color: COLORS.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>PSA estimat</div>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: confidenceColor + '22', border: `1px solid ${confidenceColor}44`, borderRadius: 6, padding: '2px 8px', marginTop: 4 }}>
                  <div style={{ width: 6, height: 6, borderRadius: '50%', background: confidenceColor }} />
                  <span style={{ fontSize: 11, fontWeight: 700, color: confidenceColor }}>{result.confidence} tillid</span>
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
              <div key={label} style={{ background: COLORS.bg + 'cc', borderRadius: 10, padding: '10px 12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ fontSize: 10, color: COLORS.muted, textTransform: 'uppercase', letterSpacing: 0.6, fontWeight: 600 }}>{label}</span>
                </div>
                {score !== null && (
                  <div style={{ height: 3, background: COLORS.border, borderRadius: 2, marginBottom: 5 }}>
                    <div style={{ height: '100%', width: `${score * 10}%`, background: barColor, borderRadius: 2, transition: 'width .6s ease' }} />
                  </div>
                )}
                <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.text, lineHeight: 1.3 }}>{value || '—'}</div>
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
              Fundne problemer ({result.mainIssues.length})
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
        <div style={{ background: COLORS.bg, borderRadius: 12, padding: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <span style={{ fontSize: 12, color: COLORS.muted, textTransform: 'uppercase', letterSpacing: 0.6, fontWeight: 600 }}>Markedsestimat</span>
            <span style={{ fontSize: 20, fontWeight: 900, color: COLORS.gold }}>{result.estimatedPSAValue}</span>
          </div>
          <div style={{ height: 1, background: COLORS.border, marginBottom: 10 }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 13, color: COLORS.muted }}>PSA-graderingsgebyr</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: COLORS.text }}>{result.gradingFee}</span>
          </div>
        </div>

        {/* Anbefaling */}
        <div style={{
          background: result.worthGrading ? COLORS.success + '0d' : COLORS.danger + '0d',
          border: `1px solid ${result.worthGrading ? COLORS.success : COLORS.danger}33`,
          borderRadius: 12, padding: 14,
          borderLeft: `3px solid ${result.worthGrading ? COLORS.success : COLORS.danger}`,
        }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: result.worthGrading ? COLORS.success : COLORS.danger, marginBottom: 6 }}>
            {result.worthGrading ? 'Anbefalet til PSA-gradering' : 'Gradering anbefales ikke'}
          </div>
          <div style={{ fontSize: 13, color: COLORS.muted, lineHeight: 1.5 }}>{result.recommendation}</div>
        </div>

        {/* Handlingsknapper */}
        {saveError && <p style={{ color: COLORS.danger, fontSize: 12, textAlign: 'center', marginBottom: 4 }}>{saveError}</p>}
        <div style={{ display: 'flex', gap: 10, paddingTop: 4 }}>
          <Btn onClick={save} disabled={saving || saved} small style={{ flex: 1 }}>
            {saved ? 'Gemt' : saving ? <Spinner size={16} color="#0a0a12" /> : 'Gem i samling'}
          </Btn>
          {navigator.share && (
            <button onClick={share} style={{ flexShrink: 0, width: 44, height: 44, borderRadius: 12, background: COLORS.card, border: `1.5px solid ${COLORS.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }} aria-label="Del analyse">
              ↑
            </button>
          )}
        </div>
      </div>
    </Card>
  )
}

// COLLECTION SCREEN
function CollectionScreen({ user }) {
  const [cards, setCards] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filterGame, setFilterGame] = useState('all')
  const [sortBy, setSortBy] = useState('newest')
  const [dbError, setDbError] = useState('')

  useEffect(() => {
    loadCards()
  }, [])

  async function loadCards() {
    setLoading(true)
    setDbError('')
    const { data, error } = await supabase.from('cards').select('*').eq('user_id', user.id).order('created_at', { ascending: false })
    if (error) {
      console.error('loadCards error:', error)
      setDbError(`DB fejl: ${error.message} (code: ${error.code})`)
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
    <div style={{ padding: '16px 16px 100px', maxWidth: 480, margin: '0 auto' }}>
      <div style={{ marginBottom: 16, paddingTop: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
          <h2 style={{ fontWeight: 900, fontSize: 22 }}>Min samling</h2>
          <div style={{ fontSize: 12, color: COLORS.muted, fontWeight: 600, paddingTop: 6 }}>{cards.length} kort</div>
        </div>
        {cards.length > 0 && (
          <div style={{ background: `linear-gradient(135deg, ${COLORS.gold}18, ${COLORS.goldDark}0a)`, border: `1px solid ${COLORS.gold}33`, borderRadius: 14, padding: '14px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 11, color: COLORS.muted, textTransform: 'uppercase', letterSpacing: 0.7, fontWeight: 600, marginBottom: 4 }}>Samlet estimeret værdi</div>
              <div style={{ fontSize: 26, fontWeight: 900, color: COLORS.gold, fontVariantNumeric: 'tabular-nums' }}>{formatEur(totalValue)}</div>
            </div>
            <div style={{ fontSize: 28 }}>💰</div>
          </div>
        )}
      </div>

      <input
        placeholder="Søg i samling..."
        value={search}
        onChange={e => setSearch(e.target.value)}
        style={{ width: '100%', background: COLORS.card, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: '12px 16px', color: COLORS.text, fontSize: 15, marginBottom: 12, outline: 'none' }}
      />

      <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 8, marginBottom: 12, scrollbarWidth: 'none' }}>
        <button onClick={() => setFilterGame('all')} style={{ flexShrink: 0, padding: '6px 14px', borderRadius: 10, background: filterGame === 'all' ? COLORS.gold + '22' : COLORS.card, border: `1.5px solid ${filterGame === 'all' ? COLORS.gold : COLORS.border}`, color: filterGame === 'all' ? COLORS.gold : COLORS.muted, fontWeight: 700, fontSize: 13 }}>Alle</button>
        {GAMES.map(g => (
          <button key={g.id} onClick={() => setFilterGame(g.id)} style={{ flexShrink: 0, padding: '6px 12px', borderRadius: 10, background: filterGame === g.id ? g.color + '22' : COLORS.card, border: `1.5px solid ${filterGame === g.id ? g.color : COLORS.border}`, color: filterGame === g.id ? g.color : COLORS.muted, fontWeight: 700, fontSize: 13 }}>
            {g.emoji}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {[['newest', 'Nyeste'], ['grade', 'Grad'], ['value', 'Værdi']].map(([val, label]) => (
          <button key={val} onClick={() => setSortBy(val)} style={{ padding: '6px 12px', borderRadius: 10, background: sortBy === val ? COLORS.gold + '22' : 'transparent', border: `1px solid ${sortBy === val ? COLORS.gold : COLORS.border}`, color: sortBy === val ? COLORS.gold : COLORS.muted, fontSize: 13, fontWeight: 600 }}>
            {label}
          </button>
        ))}
      </div>

      {dbError && <div style={{ background: COLORS.danger + '22', border: `1px solid ${COLORS.danger}`, borderRadius: 12, padding: 14, marginBottom: 16, fontSize: 13, color: COLORS.danger }}>{dbError}</div>}

      {loading ? (
        <div style={{ textAlign: 'center', padding: 60 }}><Spinner /></div>
      ) : filtered.length === 0 ? (
        <div className="fadeIn" style={{ textAlign: 'center', padding: '48px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0 }}>
          {/* Illustration: stakket kort */}
          <div style={{ position: 'relative', width: 80, height: 107, marginBottom: 28 }}>
            <div style={{ position: 'absolute', left: -10, top: 8, width: 70, height: 93, borderRadius: 8, background: COLORS.card, border: `1px solid ${COLORS.border}`, transform: 'rotate(-6deg)' }} />
            <div style={{ position: 'absolute', right: -10, top: 8, width: 70, height: 93, borderRadius: 8, background: COLORS.card, border: `1px solid ${COLORS.border}`, transform: 'rotate(6deg)' }} />
            <div style={{ position: 'absolute', inset: 0, borderRadius: 10, background: COLORS.card, border: `1.5px solid ${COLORS.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32 }}>
              {search || filterGame !== 'all' ? '🔍' : '🃏'}
            </div>
          </div>
          <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 8, color: COLORS.text }}>
            {search ? `Ingen kort matcher "${search}"` : filterGame !== 'all' ? 'Ingen kort i dette spil' : 'Din samling er tom'}
          </div>
          <div style={{ fontSize: 14, color: COLORS.muted, lineHeight: 1.6, maxWidth: 260, marginBottom: 24 }}>
            {search || filterGame !== 'all'
              ? 'Prøv et andet søgeord eller filter'
              : 'Scan dit første kort for at begynde din digitale samling'}
          </div>
          {!search && filterGame === 'all' && (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: `linear-gradient(135deg, ${COLORS.gold}, ${COLORS.goldDark})`, color: '#0a0a12', borderRadius: 12, padding: '12px 20px', fontWeight: 700, fontSize: 14 }}>
              <span>📸</span> Scan et kort nu
            </div>
          )}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {filtered.map(card => <CardItem key={card.id} card={card} onDelete={loadCards} />)}
        </div>
      )}
    </div>
  )
}

function CardItem({ card, onDelete }) {
  const game = GAMES.find(g => g.id === card.game)
  const gradeColor = card.grade >= 9 ? COLORS.success : card.grade >= 7 ? COLORS.gold : card.grade >= 5 ? '#e67e22' : COLORS.danger
  const [showDelete, setShowDelete] = useState(false)

  async function deleteCard() {
    const { error } = await supabase.from('cards').delete().eq('id', card.id).eq('user_id', card.user_id)
    if (!error) onDelete()
  }

  return (
    <div className="fadeIn" style={{ position: 'relative' }}>
      <Card style={{ padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {/* Kortbillede med grade-overlay */}
        <div style={{ position: 'relative', aspectRatio: '3/4', background: COLORS.bg, overflow: 'hidden' }}>
          {card.image_url ? (
            <img src={card.image_url} alt={card.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8 }}>
              <span style={{ fontSize: 36 }}>{game?.emoji || '🃏'}</span>
              <span style={{ fontSize: 10, color: COLORS.muted, fontWeight: 600, textTransform: 'uppercase' }}>{game?.label || 'Kort'}</span>
            </div>
          )}
          {/* PSA-grade badge i hjørne */}
          {card.grade && (
            <div style={{
              position: 'absolute', top: 8, right: 8,
              background: gradeColor, color: '#fff',
              borderRadius: 6, padding: '2px 7px',
              fontSize: 11, fontWeight: 900,
              boxShadow: `0 2px 8px ${gradeColor}66`,
            }}>
              {card.grade}
            </div>
          )}
          {/* Slet-knap som long-press overlay via toggle */}
          <button
            onClick={() => setShowDelete(v => !v)}
            style={{ position: 'absolute', top: 8, left: 8, width: 28, height: 28, borderRadius: 8, background: '#000a', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14 }}
            aria-label="Kortindstillinger"
          >
            ···
          </button>
          {showDelete && (
            <div className="fadeIn" style={{ position: 'absolute', inset: 0, background: '#000c', display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center', justifyContent: 'center' }}>
              <button onClick={deleteCard} style={{ background: COLORS.danger, color: '#fff', borderRadius: 10, padding: '10px 20px', fontWeight: 700, fontSize: 13 }}>Slet kort</button>
              <button onClick={() => setShowDelete(false)} style={{ color: COLORS.muted, fontSize: 13 }}>Annuller</button>
            </div>
          )}
        </div>

        {/* Info under billede */}
        <div style={{ padding: '10px 12px 12px' }}>
          <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 4, lineHeight: 1.3, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
            {card.name || 'Ukendt kort'}
          </div>
          {card.price_range && (
            <div style={{ fontSize: 12, color: COLORS.gold, fontWeight: 700 }}>{card.price_range}</div>
          )}
          {card.game && (
            <div style={{ fontSize: 10, color: COLORS.muted, marginTop: 2 }}>{game?.label || card.game}</div>
          )}
        </div>
      </Card>
    </div>
  )
}

// ROI CALCULATOR
function ROIScreen() {
  const [cards, setCards] = useState([{ name: '', grade: 8, currentValue: '', expectedPSAValue: '' }])
  const gradingFee = 25

  function addCard() {
    setCards(c => [...c, { name: '', grade: 8, currentValue: '', expectedPSAValue: '' }])
  }

  function updateCard(i, field, val) {
    setCards(c => c.map((card, idx) => idx === i ? { ...card, [field]: val } : card))
  }

  function removeCard(i) {
    setCards(c => c.filter((_, idx) => idx !== i))
  }

  const results = cards.map(card => {
    const cost = (parseFloat(card.currentValue) || 0) + gradingFee
    const revenue = parseFloat(card.expectedPSAValue) || 0
    const profit = revenue - cost
    const roi = cost > 0 ? ((profit / cost) * 100).toFixed(0) : 0
    return { ...card, cost, revenue, profit, roi }
  })

  const totalProfit = results.reduce((s, r) => s + r.profit, 0)
  const totalCost = results.reduce((s, r) => s + r.cost, 0)
  const totalROI = totalCost > 0 ? ((totalProfit / totalCost) * 100).toFixed(0) : 0

  const inp = { background: COLORS.bg, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: '10px 12px', color: COLORS.text, fontSize: 14, outline: 'none', width: '100%' }

  return (
    <div style={{ padding: '16px 16px 100px', maxWidth: 480, margin: '0 auto' }}>
      <h2 style={{ fontWeight: 900, fontSize: 22, marginBottom: 6, paddingTop: 8 }}>PSA Batch ROI</h2>
      <p style={{ color: COLORS.muted, fontSize: 14, marginBottom: 20 }}>Beregn om det er værd at sende dine kort til PSA-gradering.</p>

      {/* Summary */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 20 }}>
        {[['Total profit', formatEur(totalProfit), totalProfit >= 0 ? COLORS.success : COLORS.danger], ['Total ROI', `${totalROI}%`, parseFloat(totalROI) >= 0 ? COLORS.gold : COLORS.danger], ['Gebyr/kort', formatEur(gradingFee), COLORS.muted]].map(([label, val, color]) => (
          <Card key={label} style={{ padding: 12, textAlign: 'center' }}>
            <div style={{ fontSize: 11, color: COLORS.muted, marginBottom: 4 }}>{label}</div>
            <div style={{ fontWeight: 900, color, fontSize: 15 }}>{val}</div>
          </Card>
        ))}
      </div>

      {cards.map((card, i) => (
        <Card key={i} style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
            <span style={{ fontWeight: 700 }}>Kort {i + 1}</span>
            {cards.length > 1 && <button onClick={() => removeCard(i)} style={{ color: COLORS.danger, fontSize: 13 }}>Fjern</button>}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div><label style={{ fontSize: 11, color: COLORS.muted }}>Kortets nuværende værdi (€)</label><input style={inp} type="number" value={card.currentValue} onChange={e => updateCard(i, 'currentValue', e.target.value)} placeholder="0" /></div>
            <div><label style={{ fontSize: 11, color: COLORS.muted }}>Forventet PSA-værdi (€)</label><input style={inp} type="number" value={card.expectedPSAValue} onChange={e => updateCard(i, 'expectedPSAValue', e.target.value)} placeholder="0" /></div>
          </div>
          {(results[i].cost > 0 || results[i].revenue > 0) && (
            <div style={{ marginTop: 12, padding: 10, background: COLORS.bg, borderRadius: 10, display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: COLORS.muted, fontSize: 13 }}>Profit</span>
              <span style={{ fontWeight: 900, color: results[i].profit >= 0 ? COLORS.success : COLORS.danger }}>{formatEur(results[i].profit)} ({results[i].roi}% ROI)</span>
            </div>
          )}
        </Card>
      ))}

      <Btn onClick={addCard} variant="ghost" style={{ marginBottom: 12 }}>+ Tilføj kort</Btn>
    </div>
  )
}

// SETTINGS SCREEN
function SettingsScreen({ user, profile, onSignOut, onUpgrade }) {
  const [loading, setLoading] = useState(false)

  async function signOut() {
    setLoading(true)
    await supabase.auth.signOut()
    onSignOut()
  }

  return (
    <div style={{ padding: '16px 16px 100px', maxWidth: 480, margin: '0 auto' }}>
      <h2 style={{ fontWeight: 900, fontSize: 22, marginBottom: 20, paddingTop: 8 }}>Indstillinger</h2>

      {/* Profile */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ width: 52, height: 52, borderRadius: '50%', background: `linear-gradient(135deg, ${COLORS.gold}, ${COLORS.goldDark})`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22 }}>
            {user.email?.[0]?.toUpperCase()}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.email}</div>
            <Badge color={profile?.is_pro ? COLORS.gold : COLORS.muted}>{profile?.is_pro ? '⭐ Pro' : 'Gratis'}</Badge>
          </div>
        </div>
      </Card>

      {/* Pro upsell */}
      {!profile?.is_pro && (
        <Card style={{ marginBottom: 16, background: `linear-gradient(135deg, ${COLORS.gold}11, ${COLORS.goldDark}11)`, border: `1px solid ${COLORS.gold}44` }}>
          <div style={{ fontWeight: 900, fontSize: 18, marginBottom: 6 }}>⭐ Opgradér til Pro</div>
          <div style={{ color: COLORS.muted, fontSize: 14, marginBottom: 16, lineHeight: 1.6 }}>
            30 AI-scans/dag · Ubegrænset samling · Batch ROI · Prioriteret support
          </div>
          <div style={{ marginBottom: 12 }}>
            <span style={{ fontSize: 28, fontWeight: 900, color: COLORS.gold }}>4,99€</span>
            <span style={{ color: COLORS.muted, fontSize: 14 }}> /måned</span>
          </div>
          <Btn onClick={() => window.open(STRIPE_URL, '_blank')}>Køb Pro nu</Btn>
        </Card>
      )}

      {/* Stats */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 12 }}>Din aktivitet</div>
        <div style={{ display: 'flex', justifyContent: 'space-around', textAlign: 'center' }}>
          {[['Total scans', profile?.total_scans || 0], ['Kort i samling', profile?.card_count || 0], ['Scans i dag', profile?.daily_scans || 0]].map(([label, val]) => (
            <div key={label}>
              <div style={{ fontSize: 24, fontWeight: 900, color: COLORS.gold }}>{val}</div>
              <div style={{ fontSize: 12, color: COLORS.muted }}>{label}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* Links */}
      <Card style={{ marginBottom: 16 }}>
        {[['🔒 Privatlivspolitik', '/privacy.html'], ['📋 Vilkår for brug', '/terms.html']].map(([label, href]) => (
          <a key={href} href={href} target="_blank" rel="noreferrer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 0', borderBottom: `1px solid ${COLORS.border}`, color: COLORS.text, textDecoration: 'none', fontSize: 15 }}>
            {label} <span style={{ color: COLORS.muted }}>→</span>
          </a>
        ))}
        <div style={{ padding: '14px 0', color: COLORS.muted, fontSize: 13 }}>Version 1.0.0 · GradeDex EU</div>
      </Card>

      <Btn onClick={signOut} variant="danger" disabled={loading}>
        {loading ? <Spinner size={18} color={COLORS.danger} /> : 'Log ud'}
      </Btn>
    </div>
  )
}

// BOTTOM NAV
function BottomNav({ tab, setTab }) {
  const tabs = [
    { id: 'scan', label: 'Scan', emoji: '📸' },
    { id: 'collection', label: 'Samling', emoji: '🗂️' },
    { id: 'roi', label: 'ROI', emoji: '📊' },
    { id: 'settings', label: 'Profil', emoji: '⚙️' },
  ]
  return (
    <div style={{
      position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 100,
      background: COLORS.card,
      borderTop: `1px solid ${COLORS.border}`,
      display: 'flex',
      paddingBottom: 'env(safe-area-inset-bottom)',
      backdropFilter: 'blur(12px)',
    }}>
      {/* Aktiv-indikator bar øverst */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, display: 'flex' }}>
        {tabs.map(t => (
          <div key={t.id} style={{
            flex: 1,
            height: '100%',
            background: tab === t.id ? COLORS.gold : 'transparent',
            transition: 'background .2s',
            borderRadius: '0 0 2px 2px',
          }} />
        ))}
      </div>

      {tabs.map(t => {
        const isActive = tab === t.id
        return (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            aria-label={t.label}
            aria-current={isActive ? 'page' : undefined}
            style={{
              flex: 1, padding: '10px 0 10px', display: 'flex', flexDirection: 'column',
              alignItems: 'center', gap: 3, transition: 'opacity .15s',
              opacity: isActive ? 1 : 0.6,
            }}
          >
            {/* Emoji med subtil gold-glow når aktiv */}
            <div style={{
              width: 36, height: 28, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: isActive ? COLORS.gold + '18' : 'transparent',
              transition: 'background .2s',
            }}>
              <span style={{ fontSize: 18, lineHeight: 1 }}>{t.emoji}</span>
            </div>
            <span style={{
              fontSize: 10, fontWeight: isActive ? 700 : 500,
              color: isActive ? COLORS.gold : COLORS.muted,
              letterSpacing: 0.2,
              transition: 'color .2s',
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
        <h2 style={{ marginBottom: 8 }}>Noget gik galt</h2>
        <p style={{ color: COLORS.muted, marginBottom: 24, fontSize: 14 }}>{this.state.error?.message}</p>
        <button onClick={() => window.location.reload()} style={{ padding: '14px 28px', background: COLORS.gold, color: '#0a0a12', borderRadius: 14, fontWeight: 700, fontSize: 16 }}>Genindlæs app</button>
      </div>
    )
    return this.props.children
  }
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [tab, setTab] = useState('scan')
  const [onboarded, setOnboarded] = useState(() => localStorage.getItem('gd_onboarded') === '1')
  const [loading, setLoading] = useState(true)
  const [splashDone, setSplashDone] = useState(false)
  const [splashFading, setSplashFading] = useState(false)

  useEffect(() => {
    // Inject global styles
    const style = document.createElement('style')
    style.textContent = globalStyle
    document.head.appendChild(style)

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
        {tab === 'scan' && <ScanScreen user={session.user} profile={profile} onScanDone={() => loadProfile(session.user.id)} />}
        {tab === 'collection' && <CollectionScreen user={session.user} />}
        {tab === 'roi' && <ROIScreen />}
        {tab === 'settings' && <SettingsScreen user={session.user} profile={profile} onSignOut={() => setSession(null)} />}
        <BottomNav tab={tab} setTab={setTab} />
      </div>
    </ErrorBoundary>
  )
}
