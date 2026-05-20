import { useState, useEffect, useRef, useCallback, createContext, useContext } from 'react'
import { createClient } from '@supabase/supabase-js'

// ─── Supabase ────────────────────────────────────────────────────────────────
const supabase = createClient(
  'https://yezlcgooutpshqdhvufg.supabase.co',
  'sb_publishable_nM_nT5UNyciAQYqYJyr0IQ_TVVF1oGp'
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
  bg: '#0a0a12',
  card: '#13131f',
  border: '#1e1e2e',
  gold: '#e8c56d',
  goldDark: '#c9963a',
  text: '#ffffff',
  muted: '#8888aa',
  danger: '#e74c3c',
  success: '#00b894',
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

const css = (strings, ...vals) => strings.reduce((acc, s, i) => acc + s + (vals[i] ?? ''), '')

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
  button { cursor: pointer; border: none; background: none; color: inherit; font-family: inherit; }
  input, textarea { font-family: inherit; }
  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: ${COLORS.border}; border-radius: 4px; }
  @keyframes fadeIn { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:none; } }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes slideUp { from { opacity:0; transform:translateY(30px); } to { opacity:1; transform:none; } }
  @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:.5; } }
  .fadeIn { animation: fadeIn .3s ease both; }
  .slideUp { animation: slideUp .4s cubic-bezier(.34,1.56,.64,1) both; }
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
  { emoji: '📸', title: 'Scan dit kort', desc: 'Tag et billede af dit kort — AI giver et præcist PSA-gradéringsestimat på sekunder.' },
  { emoji: '💰', title: 'EUR-priser live', desc: 'Cardmarket-priser i euro direkte i appen. Altid opdaterede markedspriser.' },
  { emoji: '🗂️', title: 'Din samling', desc: 'Byg din digitale samling på tværs af 6 TCG-spil. Søg, filtrer og track din porteføljeværdi.' },
  { emoji: '🔒', title: 'GDPR-sikker', desc: 'Dine data gemmes sikkert i EU. Ingen reklamer. Du ejer dine data.', cta: true },
]

function Onboarding({ onDone }) {
  const [idx, setIdx] = useState(0)
  const slide = SLIDES[idx]
  return (
    <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 32, gap: 32 }}>
      <div key={idx} className="slideUp" style={{ textAlign: 'center', flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24 }}>
        <div style={{ fontSize: 80, lineHeight: 1 }}>{slide.emoji}</div>
        <h2 style={{ fontSize: 28, fontWeight: 900, letterSpacing: -0.5 }}>{slide.title}</h2>
        <p style={{ color: COLORS.muted, fontSize: 16, lineHeight: 1.6, maxWidth: 320 }}>{slide.desc}</p>
      </div>
      <div style={{ width: '100%', maxWidth: 360, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
          {SLIDES.map((_, i) => (
            <div key={i} style={{ width: i === idx ? 24 : 8, height: 8, borderRadius: 4, background: i === idx ? COLORS.gold : COLORS.border, transition: 'all .3s' }} />
          ))}
        </div>
        {slide.cta ? (
          <Btn onClick={onDone}>Kom i gang gratis</Btn>
        ) : (
          <Btn onClick={() => setIdx(i => i + 1)}>Næste</Btn>
        )}
        {idx === 0 && (
          <button onClick={onDone} style={{ color: COLORS.muted, fontSize: 14, textAlign: 'center' }}>Spring over</button>
        )}
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
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 48, marginBottom: 8 }}>🃏</div>
          <h1 style={{ fontSize: 28, fontWeight: 900, color: COLORS.gold }}>GradeDex EU</h1>
          <p style={{ color: COLORS.muted, marginTop: 4 }}>{mode === 'login' ? 'Log ind på din konto' : 'Opret gratis konto'}</p>
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
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { exact: 'environment' } }
        })
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
      <video ref={videoRef} playsInline style={{ width: '100%', height: 'calc(100dvh - 140px)', objectFit: 'cover' }} />
      {err && <div style={{ position: 'absolute', top: '40%', left: 0, right: 0, padding: 24, textAlign: 'center', color: COLORS.danger, fontSize: 15, background: '#000a' }}>{err}</div>}
      <div style={{ height: 140, background: '#111', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 32px', paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <button onClick={onClose} style={{ color: '#fff', fontSize: 15, padding: 12, minWidth: 80 }}>Annuller</button>
        <button onClick={capture} disabled={!ready} style={{ width: 76, height: 76, borderRadius: '50%', background: ready ? '#fff' : '#555', border: '5px solid #888', flexShrink: 0 }} />
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
      const session = await supabase.auth.getSession()
      const token = session.data.session?.access_token
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
      console.log('AI svar:', parsed)
      setResult(parsed)
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

  async function save() {
    setSaving(true)

    // Upload billede til Supabase Storage
    let imageUrl = null
    if (frontImg) {
      try {
        const parts = frontImg.split(',')
        const mime = parts[0].match(/:(.*?);/)[1]
        const binary = atob(parts[1])
        const arr = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i)
        const blob = new Blob([arr], { type: mime })
        const fileName = `${user.id}/${Date.now()}.jpg`
        const { error: upErr } = await supabase.storage
          .from('card-images')
          .upload(fileName, blob, { contentType: 'image/jpeg' })
        if (upErr) {
          console.error('Storage upload fejl:', upErr.message)
        } else {
          const { data: urlData } = supabase.storage.from('card-images').getPublicUrl(fileName)
          imageUrl = urlData.publicUrl
        }
      } catch (e) { console.error('Storage exception:', e) }
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
      image_url: imageUrl,
      notes: result.recommendation,
    })
    if (error) {
      console.error('Save error:', error)
      alert(`Fejl: ${error.message}`)
      setSaving(false)
      return
    }
    setSaved(true)
    setTimeout(onSave, 800)
    setSaving(false)
  }

  function share() {
    if (navigator.share) {
      navigator.share({ title: 'GradeDex Analyse', text: `PSA ${result.estimatedGrade} estimat — ${result.recommendation}`, url: window.location.href })
    }
  }

  return (
    <Card style={{ marginTop: 20 }} className="slideUp">
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
        {frontImg && <img src={frontImg} style={{ width: 60, aspectRatio: '3/4', objectFit: 'cover', borderRadius: 8 }} alt="kort" />}
        <div>
          <div style={{ fontSize: 13, color: COLORS.muted, marginBottom: 4 }}>Estimeret PSA-grad</div>
          <div style={{ fontSize: 48, fontWeight: 900, color: gradeColor, lineHeight: 1 }}>{result.estimatedGrade}</div>
          <Badge color={result.confidence === 'Høj' ? COLORS.success : result.confidence === 'Middel' ? COLORS.gold : COLORS.muted}>
            {result.confidence} tillid
          </Badge>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
        {[['Centrering', result.centering], ['Hjørner', result.corners], ['Kanter', result.edges], ['Overflade', result.surface]].map(([k, v]) => (
          <div key={k} style={{ background: COLORS.bg, borderRadius: 12, padding: 12 }}>
            <div style={{ fontSize: 11, color: COLORS.muted, marginBottom: 2, textTransform: 'uppercase', letterSpacing: 0.5 }}>{k}</div>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{v}</div>
          </div>
        ))}
      </div>

      {result.mainIssues?.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: COLORS.muted, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>Fundne problemer</div>
          {result.mainIssues.map((issue, i) => (
            <div key={i} style={{ fontSize: 13, color: COLORS.danger, marginBottom: 3 }}>• {issue}</div>
          ))}
        </div>
      )}

      <div style={{ background: COLORS.bg, borderRadius: 12, padding: 14, marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={{ color: COLORS.muted, fontSize: 13 }}>Estimeret PSA-værdi</span>
          <span style={{ fontWeight: 700, color: COLORS.gold }}>{result.estimatedPSAValue}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: COLORS.muted, fontSize: 13 }}>Graderingsgebyr</span>
          <span style={{ fontWeight: 700 }}>{result.gradingFee}</span>
        </div>
      </div>

      <div style={{ background: result.worthGrading ? COLORS.success + '11' : COLORS.danger + '11', border: `1px solid ${result.worthGrading ? COLORS.success : COLORS.danger}33`, borderRadius: 12, padding: 14, marginBottom: 16 }}>
        <div style={{ fontWeight: 700, color: result.worthGrading ? COLORS.success : COLORS.danger, marginBottom: 4 }}>
          {result.worthGrading ? '✅ Anbefales til gradering' : '❌ Gradering anbefales ikke'}
        </div>
        <div style={{ fontSize: 13, color: COLORS.muted }}>{result.recommendation}</div>
      </div>

      <div style={{ display: 'flex', gap: 10 }}>
        <Btn onClick={save} disabled={saving || saved} small style={{ flex: 1 }}>
          {saved ? '✅ Gemt!' : saving ? <Spinner size={16} color="#0a0a12" /> : '💾 Gem i samling'}
        </Btn>
        <Btn onClick={share} variant="ghost" small style={{ flex: 1 }}>📤 Del</Btn>
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, paddingTop: 8 }}>
        <h2 style={{ fontWeight: 900, fontSize: 22 }}>Min samling</h2>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 11, color: COLORS.muted }}>Porteføljeværdi</div>
          <div style={{ fontWeight: 900, color: COLORS.gold }}>{formatEur(totalValue)}</div>
        </div>
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
        <div style={{ textAlign: 'center', padding: 60, color: COLORS.muted }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>🃏</div>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Ingen kort endnu</div>
          <div style={{ fontSize: 14 }}>Scan dit første kort for at komme i gang</div>
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
  const gradeColor = card.grade >= 9 ? COLORS.success : card.grade >= 7 ? COLORS.gold : COLORS.danger

  async function deleteCard() {
    if (!confirm('Slet dette kort?')) return
    await supabase.from('cards').delete().eq('id', card.id)
    onDelete()
  }

  return (
    <Card style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {card.image_url ? (
        <img src={card.image_url} alt={card.name} style={{ width: '100%', aspectRatio: '3/4', objectFit: 'cover', borderRadius: 10 }} />
      ) : (
        <div style={{ aspectRatio: '3/4', background: COLORS.bg, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32 }}>
          {game?.emoji || '🃏'}
        </div>
      )}
      <div>
        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 2 }}>{card.name || 'Ukendt kort'}</div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          {card.grade && <span style={{ fontSize: 12, color: gradeColor, fontWeight: 900 }}>PSA {card.grade}</span>}
          {card.price_range && <span style={{ fontSize: 12, color: COLORS.gold, fontWeight: 700 }}>{card.price_range}</span>}
        </div>
      </div>
      <button onClick={deleteCard} style={{ color: COLORS.muted, fontSize: 11, textAlign: 'right' }}>Slet</button>
    </Card>
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
      background: COLORS.card, borderTop: `1px solid ${COLORS.border}`,
      display: 'flex', paddingBottom: 'env(safe-area-inset-bottom)',
    }}>
      {tabs.map(t => (
        <button key={t.id} onClick={() => setTab(t.id)} style={{
          flex: 1, padding: '10px 0 8px', display: 'flex', flexDirection: 'column',
          alignItems: 'center', gap: 3,
        }}>
          <span style={{ fontSize: 22 }}>{t.emoji}</span>
          <span style={{ fontSize: 11, fontWeight: 700, color: tab === t.id ? COLORS.gold : COLORS.muted }}>{t.label}</span>
          {tab === t.id && <div style={{ width: 4, height: 4, borderRadius: '50%', background: COLORS.gold }} />}
        </button>
      ))}
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
import React from 'react'

export default function App() {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [tab, setTab] = useState('scan')
  const [onboarded, setOnboarded] = useState(() => localStorage.getItem('gd_onboarded') === '1')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Inject global styles
    const style = document.createElement('style')
    style.textContent = globalStyle
    document.head.appendChild(style)

    // Init Supabase session
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      if (data.session) loadProfile(data.session.user.id)
      else setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSession(sess)
      if (sess) loadProfile(sess.user.id)
      else { setProfile(null); setLoading(false) }
    })

    return () => subscription.unsubscribe()
  }, [])

  async function loadProfile(userId) {
    const today = new Date().toISOString().slice(0, 10)
    const { data } = await supabase
      .from('profiles')
      .select('*, scan_logs(count)')
      .eq('id', userId)
      .single()

    // Count today's scans
    const { count: dailyCount } = await supabase
      .from('scan_logs')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('scan_date', today)

    // Count cards
    const { count: cardCount } = await supabase
      .from('cards')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)

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

  if (loading) return (
    <div style={{ height: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: COLORS.bg }}>
      <Spinner size={40} />
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
