/**
 * Free Scan — Node.js runtime.
 * Pipeline (parallel execution):
 *   1. OCR kortnummer  → direkte DB-opslag (primær, 100% præcis når læst)
 *   2. CLIP embedding  → pgvector cosine similarity (fallback ved OCR-fejl)
 *   3. phash           → rarity-disambiguation og tiebreaker
 *
 * VIGTIG: OCR og CLIP køres parallelt — total latency = max(ocr, clip).
 *
 * Per-spil logik:
 *   Pokemon/MTG/Lorcana : number+setTotal → enkelt kort
 *   YGO/DBS/OnePiece    : alfanumerisk kode → 1-10 rarity-varianter → CLIP+phash vælger
 */

import sharp     from 'sharp'

const SUPABASE_URL  = process.env.SUPABASE_URL
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY
const EMBED_URL     = process.env.EMBED_SERVICE_URL?.trim()   // Railway: https://xxx.up.railway.app
const EMBED_SECRET  = process.env.EMBED_SECRET?.trim()        // Delt hemmelighed
const OCR_SERVICE_URL = process.env.OCR_SERVICE_URL?.trim()   // Railway PaddleOCR-service (separat). Unset → Tesseract-fallback.

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

const VALID_GAMES = ['pokemon', 'pokemonjp', 'mtg', 'yugioh', 'onepiece', 'lorcana', 'dragonball', 'riftbound']

// ─── Helpers ──────────────────────────────────────────────────────────────
function hammingDist(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity
  let d = 0
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16)
    while (x) { d += x & 1; x >>= 1 }
  }
  return d
}

// ─── phash ────────────────────────────────────────────────────────────────
async function computePhash(buf) {
  const SIZE = 8
  try {
    const px = await sharp(buf).resize(SIZE + 1, SIZE, { fit: 'fill' }).grayscale().raw().toBuffer()
    let bits = ''
    for (let r = 0; r < SIZE; r++)
      for (let c = 0; c < SIZE; c++)
        bits += px[r * (SIZE + 1) + c] < px[r * (SIZE + 1) + c + 1] ? '1' : '0'
    let hex = ''
    for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16)
    return hex
  } catch { return null }
}

// ─── Railway embedding + OCR service ──────────────────────────────────────
// OCR kører nu på Railway (varm Tesseract-worker, ingen Vercel cold-start).
// Se packages/scanner/card-ocr.js + railway-server.js.
async function getServerEmbedding(base64Image, game) {
  if (!EMBED_URL) { console.error('[embed] EMBED_SERVICE_URL not set'); return null }
  const attempt = async () => {
    const r = await fetch(`${EMBED_URL}/embed`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(EMBED_SECRET ? { Authorization: `Bearer ${EMBED_SECRET}` } : {}),
      },
      body:   JSON.stringify({ image: `data:image/jpeg;base64,${base64Image}`, game }),
      signal: AbortSignal.timeout(18000),
    })
    if (!r.ok) throw new Error(`Railway ${r.status}`)
    const data = await r.json()
    if (!Array.isArray(data.embedding) || data.embedding.length !== 512) throw new Error('bad embedding shape')
    return { embedding: data.embedding, ocr: data.ocr ?? null }
  }
  try {
    return await attempt()
  } catch (e) {
    console.error('[embed] attempt 1 failed:', e.message, '— retrying')
    try {
      return await attempt()
    } catch (e2) {
      console.error('[embed] attempt 2 failed:', e2.message)
      return null
    }
  }
}

// ─── PaddleOCR-service (separat Railway-service) ──────────────────────────
// Læser kortnummer OG kortnavn. Erstatter Railways svage Tesseract når sat.
// Returnerer { number, setTotal, isCode, name }. null hvis unset/fejl → Tesseract-fallback.
async function getOcrService(base64Image, game) {
  if (!OCR_SERVICE_URL) return null
  try {
    const r = await fetch(`${OCR_SERVICE_URL}/ocr`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', ...(EMBED_SECRET ? { Authorization: `Bearer ${EMBED_SECRET}` } : {}) },
      body:    JSON.stringify({ image: `data:image/jpeg;base64,${base64Image}`, game }),
      signal:  AbortSignal.timeout(22000),   // multi-pass voting er tungere → mere margin
    })
    if (!r.ok) return null
    return await r.json()
  } catch { return null }
}

// ─── Supabase ─────────────────────────────────────────────────────────────
const sbh = () => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' })

// Navn-søgning: hent katalog-kort hvis navn matcher OCR-navnet. Grov prefix-ilike
// server-side, så normaliseret fuzzy-match i JS (mellemrum-/tegn-immun: "GalarianArticuno"
// == "Galarian Articuno"). Bringer det rigtige kort i puljen selv når CLIP missede det (rank -1).
const normName = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
// Edit-distance ≤1 (én substitution/indsættelse/sletning) — tolererer enkelt OCR-tegnfejl i navnet
// ("Umezaws"→"Umezawa"). Sikkert: interleave-pre-filteret har allerede narrowet til navne-lignende
// kort, så ≤1 på det FULDE normaliserede navn giver ingen falske positiver (verificeret offline).
function editLE1(a, b) {
  if (a === b) return true
  const la = a.length, lb = b.length
  if (Math.abs(la - lb) > 1) return false
  if (la === lb) { let d = 0; for (let i = 0; i < la; i++) if (a[i] !== b[i] && ++d > 1) return false; return true }
  const s = la < lb ? a : b, l = la < lb ? b : a   // s kortere, l én længere
  let i = 0, j = 0, diff = 0
  while (i < s.length && j < l.length) { if (s[i] === l[j]) { i++; j++ } else { if (++diff > 1) return false; j++ } }
  return true
}
async function nameSearch(game, ocrName) {
  const b = normName(ocrName)
  // Mellemrum/tegn-INSENSITIVT prefix: interleave de første alfanumeriske tegn med wildcards
  // (*t*h*e*w*a*n*d*) så ILIKE matcher uanset mellemrum/komma i kortnavnet ELLER mellemrum droppet
  // af OCR. Det gamle space-strippede prefix (*TheW*) matchede ALDRIG multi-ord-navne ("The Wandering
  // Emperor", "Ao, the Dawn Sky") mod det rå navn med mellemrum → navn-injektion fejlede for de fleste
  // MTG-kort (8-tegns interleave er selektiv: ~6-26 hits, JS-filteret narrows til eksakt normaliseret navn).
  const chars = b.replace(/[^a-z0-9]/g, '').slice(0, 8)
  if (b.length < 4 || chars.length < 4) return []
  const pattern = '*' + chars.split('').join('*') + '*'
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/card_catalog?game=eq.${game}&name=ilike.${pattern}&number=not.like.product-*&select=id,name,number,phash&limit=1500`,
    { headers: sbh() })
  if (!r.ok) return []
  const rows = await r.json()
  return rows.filter(c => { const a = normName(c.name); return a && (a === b || a.includes(b) || b.includes(a) || editLE1(a, b)) })
}

// ─── JP katakana-navnematch ────────────────────────────────────────────────
// normName strippet til [a-z0-9] → katakana blev TOM → derfor var navn-injektion død for JP.
// normNameJa beholder katakana og folder small→large-kana + stripper ー/・ → small/large-kana-
// immun (ティ↔テイ, ッ↔ツ). IDENTISK med SQL-foldningen i name_ja_norm-kolonnen, så OCR-token
// og katalog-kolonne sammenlignes i samme normalform.
const SMALL_KANA = { 'ァ': 'ア', 'ィ': 'イ', 'ゥ': 'ウ', 'ェ': 'エ', 'ォ': 'オ', 'ッ': 'ツ', 'ャ': 'ヤ', 'ュ': 'ユ', 'ョ': 'ヨ', 'ヮ': 'ワ', 'ヵ': 'カ', 'ヶ': 'ケ' }
// Trainer/item-navne er kanji+hiragana+katakana (博士の研究, ふしぎなアメ) — ikke kun katakana som Pokémon.
// Behold alle 3 scripts; normalisér hiragana→katakana (script-variant-immun) + fold small-kana; ー/・ falder
// udenfor og droppes. Bagud-kompatibel: rene katakana-navne (Pokémon) folder identisk med før.
function normNameJa(s) {
  let out = ''
  for (const ch of String(s || '')) {
    const cp = ch.codePointAt(0)
    if (cp >= 0x3041 && cp <= 0x3096) { const k = String.fromCodePoint(cp + 0x60); out += SMALL_KANA[k] || k }  // hiragana→katakana
    else if (cp >= 0x30A1 && cp <= 0x30FA) { out += SMALL_KANA[ch] || ch }                                       // katakana
    else if (cp >= 0x4E00 && cp <= 0x9FFF) { out += ch }                                                          // kanji
  }
  return out
}

// JP navn-injektion (analog til nameSearch): bring CLIP-missede JP-kort i puljen via katakana-navnet.
// OCR'er med støj i BEGGE ender ("コリザードンでマ" for リザードン). name_ja_norm er et SAMMENHÆNGENDE
// udsnit af det foldede token → generér alle 3-7-tegns understrenge og eksakt-match (IN) mod den
// foldede kolonne → støj-immun i begge ender og præcis (kun rigtige navne matcher eksakt).
async function nameSearchJa(game, ocrTexts) {
  const tokens = [...new Set((ocrTexts || []).map(normNameJa).filter(t => t.length >= 3))]
  if (!tokens.length) return []
  const subs = new Set()
  for (const t of tokens) for (let len = 3; len <= 7; len++) for (let i = 0; i + len <= t.length; i++) subs.add(t.slice(i, i + len))
  if (!subs.size) return []
  const inList = [...subs].slice(0, 300).map(s => `"${encodeURIComponent(s)}"`).join(',')
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/card_catalog?game=eq.${game}&name_ja_norm=in.(${inList})&number=not.like.product-*&select=id,name,number,phash,name_ja_norm&limit=600`,
    { headers: sbh() })
  if (!r.ok) return []
  return await r.json()
}

// Nummer-injektion (analog til nameSearch): hent alle tryk med numerator==num OG denominator==total.
// KRITISK gate (kaldes kun når BÅDE nummer OG setTotal er læst = høj konfidens): på holo/full-art/
// regeltekst-fotos fejler navne-parseren ofte (læser angrebstekst), så det rigtige kort er hverken i
// CLIP-puljen el. navn-injiceret. Når nummeret+totalen ER læst, henter dette det/de rigtige tryk ind;
// flere sæt deler samme størrelse (fx /102 = Base Set OG Triumphant) → CLIP-rank afgør visuelt blandt dem.
async function numberSearch(game, num, total) {
  if (num == null || !total) return []
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/card_catalog?game=eq.${game}&number=like.*/${total}&number=not.like.product-*&select=id,name,number,phash&limit=400`,
    { headers: sbh() })
  if (!r.ok) return []
  const want = String(parseInt(num, 10))
  return (await r.json()).filter(c => {
    const m = String(c.number ?? '').match(/^(\d{1,4})\s*\//)
    return m && String(parseInt(m[1], 10)) === want
  })
}

// Region-agnostisk set-kode-nøgle: PREFIX-<region?><digits> → "PREFIX|<int>". Immun mod region-
// varianter OG OCR-region-misreads (LOB-EN005 ~ LOB-005 ~ LOB-O05 ~ LOB-FR005 → alle "LOB|5").
function codeKeyN(s) {
  const m = String(s ?? '').toUpperCase().match(/^([A-Z0-9]+)-[A-Z]*?(\d+)$/)
  return m ? `${m[1]}|${parseInt(m[2], 10)}` : null
}

// Kode-injektion (CODE_GAMES: yugioh/dbs/onepiece). Set-koden identificerer BÅDE kortet OG trykket
// unikt → henter de(t) kort ind hvis kode matcher OCR'ens (region-agnostisk: LOB-EN005 ~ LOB-005).
// Løser modern-kollaps (CLIP forkert kort) + same-art print-miss: en bonus kan ikke booste et kort
// der ikke er i puljen, men CLIP-navnepuljen misser tit det rigtige tryk/kort på foil-tunge YGO-kort.
async function codeSearch(game, code) {
  const m = String(code ?? '').toUpperCase().match(/^([A-Z0-9]+)-[A-Z]*?(\d+)$/)
  if (!m) return []
  const prefix = m[1], want = String(parseInt(m[2], 10))
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/card_catalog?game=eq.${game}&number=like.${encodeURIComponent(prefix + '-*')}&number=not.like.product-*&select=id,name,number,phash&limit=200`,
    { headers: sbh() })
  if (!r.ok) return []
  return (await r.json()).filter(c => {
    const cm = String(c.number ?? '').toUpperCase().match(/^[A-Z0-9]+-[A-Z]*?(\d+)$/)
    return cm && String(parseInt(cm[1], 10)) === want
  })
}

// Cosine-similarity i JS (samme mål som match_cards' 1-(embedding<=>query)) — til CLIP-ranking
// af navn-injicerede kort der ligger UDEN FOR CLIP-poolen (top-30).
function cosineSim(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  const d = Math.sqrt(na) * Math.sqrt(nb)
  return d ? dot / d : 0
}

// Hent embeddings for specifikke id'er (navn-injicerede kort) → så vi kan give dem en ægte
// visuel score i stedet for clipSim=0. Distinkt-art-rarities (SIR/IR/secret) vinder så blandt
// samme-navn-tryk; same-art (reverse/promo) forbliver tæt → number/phash afgør.
async function fetchEmbeddings(ids) {
  if (!ids.length) return {}
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/card_catalog?id=in.(${ids.map(id => `"${id}"`).join(',')})&select=id,embedding`,
    { headers: sbh() })
  if (!r.ok) return {}
  const out = {}
  for (const row of await r.json()) {
    if (!row.embedding) continue
    out[row.id] = typeof row.embedding === 'string' ? JSON.parse(row.embedding) : row.embedding
  }
  return out
}

// Hent foldet name_ja_norm for kandidat-id'er (JP) → så nameBonusJa kan score HELE puljen
// (CLIP- og nummer-injicerede kort, ikke kun navn-injicerede). Ét kald, kun for pokemonjp.
async function fetchNameJaNorm(ids) {
  if (!ids.length) return {}
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/card_catalog?id=in.(${ids.map(id => `"${id}"`).join(',')})&select=id,name_ja_norm`,
    { headers: sbh() })
  if (!r.ok) return {}
  const out = {}
  for (const row of await r.json()) out[row.id] = row.name_ja_norm ?? null
  return out
}

// Per-kandidat navn-bonus (analog til numberBonus): boost et kort hvis dets navn matcher OCR-navnet.
// Krydsvalidering: navn-match (+0.45) + nummer-match (numberBonus +0.55) → ~1.0 → vinder sikkert.
function nameBonus(candName, ocrName) {
  if (!ocrName || !candName) return 0
  const a = normName(candName), b = normName(ocrName)
  if (!a || !b || b.length < 4) return 0
  if (a === b) return 0.45
  if (a.includes(b) || b.includes(a)) return 0.30
  if (editLE1(a, b)) return 0.40   // 1-tegns OCR-typo på fuldt navn = stærkt signal (matcher nameSearch's fuzzy-injektion)
  return 0
}

// JP-variant: sammenlign kandidatens foldede name_ja_norm mod de foldede OCR-katakana-tokens.
function nameBonusJa(candNameJaNorm, ocrJaTokens) {
  const a = candNameJaNorm
  if (!a || a.length < 3 || !ocrJaTokens?.length) return 0
  for (const t of ocrJaTokens) {
    if (t === a) return 0.45
    if (t.includes(a) || a.includes(t)) return 0.30
  }
  return 0
}

// Per-spil CLIP-pool størrelse
const CLIP_MATCH_COUNT = { pokemon: 30, pokemonjp: 30, dragonball: 40, yugioh: 40, default: 25 }

// YGO: ren CLIP — phash er ens for alle rarities (samme artwork)
// DBS: lav phash-vægt — rarities kan dele artwork
// Resten: CLIP + phash
const PHASH_SCORE_WEIGHTS = {
  yugioh:     { clip: 1.00, phash: 0.00 },
  dragonball: { clip: 0.80, phash: 0.20 },
  default:    { clip: 0.65, phash: 0.25 },
}

async function clipSearch(embedding, game, count) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_cards`, {
    method:  'POST',
    headers: sbh(),
    body:    JSON.stringify({ query_embedding: `[${embedding.join(',')}]`, game_filter: game, match_count: count }),
    signal:  AbortSignal.timeout(5000),
  })
  if (!r.ok) return null
  return r.json()
}

async function phashSearch(game, uploadedHash) {
  const all = []
  let offset = 0
  while (true) {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/card_catalog?game=eq.${game}&phash=not.is.null&number=not.like.product-*&select=id,name,number,phash&limit=1000&offset=${offset}`,
      { headers: sbh() }
    )
    if (!r.ok) break
    const batch = await r.json()
    all.push(...batch)
    if (batch.length < 1000) break
    offset += 1000
  }
  return all
    .filter(c => !String(c.id ?? '').includes('product'))   // produkter forurener ranking — også i phash-stien
    .map(c => ({ id: c.id, name: c.name ?? null, number: c.number ?? null, dist: hammingDist(uploadedHash, c.phash) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 50)
}

async function fetchDetails(ids) {
  if (!ids.length) return []
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/card_catalog?id=in.(${ids.map(id => `"${id}"`).join(',')})&select=id,name,number,set_id,set_name,rarity,finish_types,image_url,game`,
    { headers: sbh() }
  )
  return r.ok ? r.json() : []
}

// Parse et korts number-felt: "004/102" → {num:"4", total:102}; "4" → {num:"4", total:null}
function parseCardNum(s) {
  if (s == null) return { num: null, total: null, raw: '' }
  const str = String(s).toUpperCase()
  const m = str.match(/(\d{1,4})\s*\/\s*(\d{1,4})/)
  if (m) return { num: String(parseInt(m[1], 10)), total: parseInt(m[2], 10), raw: str }
  const bare = str.match(/(\d{1,4})/)
  return { num: bare ? String(parseInt(bare[1], 10)) : null, total: null, raw: str }
}

// OCR forfiner CLIP: boost en kandidat hvis dens EGET nummer matcher OCR. Kandidatens
// number-felt ("004/102") indeholder både nummer OG total → robust mod katalog-bred
// RPC's LIMIT/tolerance-problemer og mod OCR-misreads (en forkert OCR booster bare intet).
function numberBonus(candNumber, ocr) {
  if (!ocr?.number) return 0
  const cand = parseCardNum(candNumber)
  if (ocr.isCode) {
    // Region-agnostisk: OCR læser tit regionen forkert/mangelfuldt ("PSV-O11"/"BLAR-ENO54" vs
    // katalogets "PSV-EN011"/"BLAR-EN054") → sammenlign KUN set-prefix + trailing-nummer.
    const a = codeKeyN(cand.raw), b = codeKeyN(ocr.number)
    return a && b && a === b ? 0.55 : 0
  }
  if (cand.num == null || cand.num !== String(ocr.number)) return 0
  if (ocr.setTotal && cand.total) return cand.total === ocr.setTotal ? 0.55 : 0.12  // total skelner base vs base2
  return 0.30
}

// Auto-crop (v3): find kortets bbox via GRADIENT-PROJEKTION i stedet for farve. Kortets indre
// (tekst/art/border) er kant-tæt; baggrunds-margener er kant-fattige → trim de yderste rækker/
// kolonner hvor gradient-massen falder under tærsklen. Robust mod teksturerede/FARVEDE baggrunde
// (v2's farve-heuristik fejlede på fx lilla bord der varierede nok til at tælle som "kort").
// Konfidens-guard: cropper KUN når den trimmede margen er klart kant-fattigere end kort-kernen
// (ellers er billedet kant-tæt overalt = clean render el. busy bg → no-op, sikkert).
// Generøs bund-padding så nummer-båndet aldrig skæres (OCR-zonen ligger der).
async function autoCropCard(buf) {
  try {
    const N = 256
    const { data, info } = await sharp(buf).resize(N, N, { fit: 'fill' }).grayscale().blur(0.6).raw().toBuffer({ resolveWithObject: true })
    const w = info.width, h = info.height, g = (x, y) => data[y * w + x]
    const rowMass = new Array(h).fill(0), colMass = new Array(w).fill(0)
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const m = Math.abs(g(x + 1, y) - g(x - 1, y)) + Math.abs(g(x, y + 1) - g(x, y - 1)); rowMass[y] += m; colMass[x] += m
    }
    const smooth = p => p.map((_, i) => { let s = 0, n = 0; for (let k = -2; k <= 2; k++) { const j = i + k; if (j >= 0 && j < p.length) { s += p[j]; n++ } } return s / n })
    const rM = smooth(rowMass), cM = smooth(colMass)
    const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
    const extent = (p, th) => { let a = 0, b = p.length - 1; while (a < p.length && p[a] < th) a++; while (b > a && p[b] < th) b--; return [a, b] }
    const [top, bot] = extent(rM, median(rM) * 0.40), [lft, rgt] = extent(cM, median(cM) * 0.40)
    const bw = rgt - lft, bh = bot - top, frac = (bw * bh) / (w * h)
    const coreMean = rM.slice(top, bot + 1).reduce((s, v) => s + v, 0) / Math.max(1, bh)
    const marginRows = [...rM.slice(0, top), ...rM.slice(bot + 1)]
    const marginMean = marginRows.length ? marginRows.reduce((s, v) => s + v, 0) / marginRows.length : coreMean
    // Guards: kort fylder rammen (clean) ELLER detektion fejlede ELLER ingen klar kant-fattig margen → no-op
    if (frac > 0.86 || bw < w * 0.35 || bh < h * 0.35 || marginMean >= coreMean * 0.55) return buf
    const meta = await sharp(buf).metadata()
    const L = Math.max(0, Math.floor((lft / w - 0.015) * meta.width))
    const T = Math.max(0, Math.floor((top / h - 0.02) * meta.height))
    const R = Math.min(meta.width, Math.ceil((rgt / w + 0.015) * meta.width))
    const B = Math.min(meta.height, Math.ceil((bot / h + 0.04) * meta.height))   // +4% bund: bevar nummer-båndet
    // Aspekt-guard: et Pokemon-kort er ~0.71. Hvis bbox'en bliver unaturligt smal/bred (<0.55 el. >0.95)
    // har gradient-projektionen fejlet (fx full-art/secret-holo i toploader → skar nummer-zonen væk) → no-op.
    const boxAspect = (R - L) / Math.max(1, B - T)
    if (boxAspect < 0.55 || boxAspect > 0.95) return buf
    return await sharp(buf).extract({ left: L, top: T, width: R - L, height: B - T }).toBuffer()
  } catch { return buf }
}

// ─── Handler ───────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v))
    return res.status(200).end()
  }
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v))
  res.setHeader('Content-Type', 'application/json')
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let body
  try {
    body = await new Promise((resolve, reject) => {
      let d = ''; req.on('data', c => d += c); req.on('end', () => resolve(JSON.parse(d))); req.on('error', reject)
    })
  } catch { return res.status(400).json({ error: 'Invalid JSON' }) }

  const { image, game, embedding: clientEmbedding, clientPhash: incomingPhash } = body
  if (!image) return res.status(400).json({ error: 'image required (base64 dataURL)' })

  const safeGame = VALID_GAMES.includes(game) ? game : 'pokemon'
  const base64   = image.replace(/^data:image\/\w+;base64,/, '')
  const imgBuf   = Buffer.from(base64, 'base64')

  let normalizedBuf
  try {
    // 1300px: bevarer nok detalje til at OCR-servicen kan læse små 3-cifrede full-art-numre
    // (IR/SIR). CLIP-thumben nedskaleres alligevel til 800 → uændret for CLIP.
    normalizedBuf = await sharp(imgBuf).resize(1300).jpeg({ quality: 90 }).toBuffer()
  } catch { normalizedBuf = imgBuf }

  const matchCount = CLIP_MATCH_COUNT[safeGame] ?? CLIP_MATCH_COUNT.default

  // ── Parallel: Railway embedding + OCR kører samtidigt ────────────────────
  // Prioritet: Railway (server-side, altid stabil) > client-CLIP (WASM, upålidelig)
  // VIGTIGT: bevar aspect ratio (fit:inside) — IKKE stretch. Railway/CLIP-processoren
  // laver selv resize(224)+center-crop, præcis som backfill. Stretch gav cosine 0.85
  // mod kataloget (skulle være ~1.0) → forkerte matches.
  // CLIP: auto-crop kortet ud af baggrunden → 800px (processoren nedskalerer til 224) så
  // kortet fylder rammen som i kataloget. OCR: servicen ejer nu HELE preprocessingen (cv2
  // card_crop + perspektiv-deskew, valideret offline 211-korts harness 180→186, +6/-0) →
  // send et UKROPPET 1300px LOSSLESS PNG. PNG (ikke jpeg) bevarer skarpe kanter til kontur-
  // detektionen (jpeg blødgjorde kanten → small full-art-firkanter forsvandt). De to stier er
  // afkoblet så et fejlet CLIP-crop ikke smider det gode OCR-input væk.
  let clipInputBase64 = null
  let ocrInputBase64  = null
    // sharp opskalerer små billeder til 1300px (lanczos3) FØR send. Empirisk (benchmark + 5-vs-1
    // deterministisk test) giver lanczos3-opskaleringen BEDRE nummer-læsbarhed end PIL/bicubic for
    // små full-art/holo-numre (Pachirisu/Latias/Ledian/Nidorino/Pikachu173 læser kun korrekt MED
    // opskalering). `withoutEnlargement` blev prøvet for at fixe Slowpoke 81→1 men regresserede de
    // 5 → revertet. Lektie: harness'ens PIL-resize er IKKE den mest nøjagtige sti for små billeder.
  try {
    ocrInputBase64 = (await sharp(imgBuf).resize(1300).png().toBuffer()).toString('base64')
  } catch { ocrInputBase64 = normalizedBuf.toString('base64') }
  try {
    const cropped = await autoCropCard(normalizedBuf)
    clipInputBase64 = (await sharp(cropped).resize(800, 800, { fit: 'inside' }).jpeg({ quality: 85 }).toBuffer()).toString('base64')
  } catch { clipInputBase64 = normalizedBuf.toString('base64') }

  // Ét VARMT Railway-kald returnerer BÅDE embedding og OCR. Erstatter Vercels
  // cold-start-Tesseract (som tog ~11s → "server error"). Nu ~1-2s.
  const scanDiag = { thumbLen: clipInputBase64?.length ?? 0, embedUrlOk: !!EMBED_URL }
  const _t0Rwy = Date.now()
  // CLIP-embedding + PaddleOCR kører PARALLELT (separate Railway-services) → latency = max, ikke sum.
  const [railway, ocrService] = await Promise.all([
    getServerEmbedding(clipInputBase64, safeGame),
    getOcrService(ocrInputBase64, safeGame),
  ])
  scanDiag.railwayMs = Date.now() - _t0Rwy
  scanDiag.railwayOk = !!railway?.embedding
  scanDiag.ocrSvc    = ocrService ? 'ok' : (OCR_SERVICE_URL ? 'fail' : 'unset')
  const railwayEmbedding = railway?.embedding ?? null
  // OCR: foretræk PaddleOCR-servicen (læser nummer OG navn); fald tilbage til Railways Tesseract.
  const ocrResult = ocrService ?? railway?.ocr ?? null
  const ocrName   = ocrService?.name ?? null
  // JP: foldede katakana-tokens fra ALLE OCR-linjer (robust mod hvilken linje navnet lander i)
  const ocrJaTokens = safeGame === 'pokemonjp'
    ? [...new Set((ocrService?.texts ?? []).map(normNameJa).filter(t => t.length >= 3))]
    : []

  const clientFallback = (clientEmbedding && Array.isArray(clientEmbedding) && clientEmbedding.length === 512)
    ? clientEmbedding : null
  const activeEmbedding = railwayEmbedding ?? clientFallback

  let clipAll = null
  if (activeEmbedding) {
    const _t0Clip = Date.now()
    const _clipRaw = await clipSearch(activeEmbedding, safeGame, matchCount).catch(e => { scanDiag.clipErr = e.message; return null })
    scanDiag.clipMs = Date.now() - _t0Clip
    scanDiag.clipStatus = Array.isArray(_clipRaw) ? _clipRaw.length : (_clipRaw === null ? 'null' : 'other')
    clipAll = _clipRaw
  }
  // Filtrer produkter (blister-packs, tins, booster-boxes) fra CLIP — de forurener ranking.
  // Tjek BÅDE id og number: nogle produkter har 'product-NNN' i number-feltet, ikke i id.
  const isProduct = c => String(c.id ?? '').includes('product') || String(c.number ?? '').startsWith('product')
  const clipResultsRaw = clipAll ? clipAll.filter(c => !isProduct(c)) : null

  // phash (hurtigt, kør efter parallelfasen)
  const serverPhash   = await computePhash(normalizedBuf)
  const uploadedPhash = serverPhash ?? (typeof incomingPhash === 'string' && incomingPhash.length === 16 ? incomingPhash : null)

  // ── OCR-resultat ──────────────────────────────────────────────────────────
  // OCR OVERSKRIVER IKKE CLIP. Den bruges som per-kandidat number-bonus i scoringen
  // nedenfor (numberBonus): CLIP finder det rigtige kort visuelt, OCR-nummeret vælger
  // det rigtige TRYK blandt kandidaterne. Robust mod OCR-misreads og set-total-kollisioner.
  const ocrNum      = ocrResult?.number   ?? null
  const ocrSetTotal = ocrResult?.setTotal ?? null

  // ── SCORING: CLIP + phash + OCR number-bonus ─────────────────────────────
  // Fallback-hierarki:
  //   1. CLIP pool ≥ 5  → brug CLIP som primær (clip*0.65 + phash*0.25 + number)
  //   2. Ingen brugbar CLIP → ren phash-only + number
  const MIN_CLIP_POOL = 5
  let usedClip    = false
  let clipResults = (clipResultsRaw && clipResultsRaw.length >= MIN_CLIP_POOL) ? clipResultsRaw : null

  if (clipResults) usedClip = true

  let candidatePool
  if (usedClip) {
    candidatePool = clipResults.map(c => ({
      id:        c.id,
      name:      c.name ?? null,
      number:    c.number ?? null,
      phash:     c.phash ?? null,
      clipSim:   typeof c.similarity === 'number' ? c.similarity : 0,
      phashDist: uploadedPhash ? hammingDist(uploadedPhash, c.phash) : null,
    }))
  } else {
    // Ingen brugbar CLIP (embedding mangler eller IVFFlat for sparsom) → phash-only
    if (clipResultsRaw && clipResultsRaw.length > 0) {
      console.log('[scan] clip pool sparse (' + clipResultsRaw.length + '), fallback til phash')
    }
    const phashHits = uploadedPhash ? await phashSearch(safeGame, uploadedPhash) : []
    candidatePool = phashHits.map(c => ({ id: c.id, name: c.name ?? null, number: c.number ?? null, phash: null, clipSim: 0, phashDist: c.dist }))
  }

  // Injicér navn-matchede katalog-kort. KRITISK: på holo-fotos er det rigtige kort ofte CLIP
  // rank -1 (slet ikke i puljen) — en bonus kan ikke booste et fraværende kort. Navn-søgning
  // henter alle tryk af det OCR-læste navn ind; numberBonus vælger så det rigtige tryk (krydsvalidering).
  if (ocrName || ocrJaTokens.length) {
    const existing = new Set(candidatePool.map(c => c.id))
    // JP: match katakana-navnet mod name_ja_norm; ellers det engelske navn mod name.
    const nameHits = (safeGame === 'pokemonjp'
      ? await nameSearchJa(safeGame, ocrService?.texts ?? []).catch(() => [])
      : await nameSearch(safeGame, ocrName).catch(() => [])
    ).filter(h => !existing.has(h.id))
    // CLIP-rank de injicerede kort: ægte cosine mod scan-embeddingen (ikke clipSim=0). Distinkt-art-
    // rarities (SIR/IR/secret) vinder så visuelt blandt samme-navn-tryk; numberBonus afgør same-art.
    const embMap = activeEmbedding ? await fetchEmbeddings(nameHits.map(h => h.id)).catch(() => ({})) : {}
    for (const hch of nameHits) {
      existing.add(hch.id)
      const emb = embMap[hch.id]
      candidatePool.push({
        id: hch.id, name: hch.name ?? null, number: hch.number ?? null, phash: hch.phash ?? null,
        nameJaNorm: hch.name_ja_norm ?? null,
        clipSim: emb ? cosineSim(activeEmbedding, emb) : 0,
        phashDist: (uploadedPhash && hch.phash) ? hammingDist(uploadedPhash, hch.phash) : null,
      })
    }
    scanDiag.nameHits = nameHits.length
  }

  // Nummer-injektion: når BÅDE nummer OG setTotal er læst (høj konfidens), hent num/total-trykkene ind.
  // Redder de tilfælde hvor navne-parseren fejlede (læste regeltekst → nameHits=0) ELLER kortet har
  // distinkt art (LV.X/Prime/LEGEND/full-art) så CLIP ikke rangerede det — nummeret læses tit korrekt
  // her, men en bonus kan ikke booste et fraværende kort. setTotal-gaten gør at en bar numerator-
  // misread (uden total) IKKE trigger injektion (det var hvorfor ren nummer-injektion blev revertet).
  if (ocrNum && ocrSetTotal) {
    const existing = new Set(candidatePool.map(c => c.id))
    const numHits = (await numberSearch(safeGame, ocrNum, ocrSetTotal).catch(() => [])).filter(h => !existing.has(h.id))
    const embMap = activeEmbedding ? await fetchEmbeddings(numHits.map(h => h.id)).catch(() => ({})) : {}
    for (const hch of numHits) {
      const emb = embMap[hch.id]
      candidatePool.push({
        id: hch.id, name: hch.name ?? null, number: hch.number ?? null, phash: hch.phash ?? null,
        clipSim: emb ? cosineSim(activeEmbedding, emb) : 0,
        phashDist: (uploadedPhash && hch.phash) ? hammingDist(uploadedPhash, hch.phash) : null,
      })
    }
    scanDiag.numHits = numHits.length
  }

  // Kode-injektion (CODE_GAMES): den læste set-kode pinner både rigtigt KORT og rigtigt TRYK.
  // Gated på isCode + læst kode. numberBonus giver de kode-matchede +0.55 → vinder trods CLIP-
  // forvirring; CLIP-cosine bryder tie blandt same-kode-rarity-varianter.
  if (ocrResult?.isCode && ocrNum) {
    const existing = new Set(candidatePool.map(c => c.id))
    const codeHits = (await codeSearch(safeGame, ocrNum).catch(() => [])).filter(h => !existing.has(h.id))
    const embMap = activeEmbedding ? await fetchEmbeddings(codeHits.map(h => h.id)).catch(() => ({})) : {}
    for (const hch of codeHits) {
      const emb = embMap[hch.id]
      candidatePool.push({
        id: hch.id, name: hch.name ?? null, number: hch.number ?? null, phash: hch.phash ?? null,
        clipSim: emb ? cosineSim(activeEmbedding, emb) : 0,
        phashDist: (uploadedPhash && hch.phash) ? hammingDist(uploadedPhash, hch.phash) : null,
      })
    }
    scanDiag.codeHits = codeHits.length
  }

  if (!candidatePool.length) {
    return res.status(200).json({
      candidates: [], confidence: 'low', best: null,
      ocr:  (ocrNum || ocrName) ? { number: ocrNum, setTotal: ocrSetTotal, name: ocrName } : null,
      method: 'no-candidates',
      meta:  { game: safeGame, clip: usedClip, pool: 0, ...scanDiag },
    })
  }

  // JP: hent foldet name_ja_norm for de kandidater der mangler det (CLIP-/nummer-injicerede) → så
  // nameBonusJa kan score HELE puljen, ikke kun de navn-injicerede. Ét kald, kun for pokemonjp.
  if (safeGame === 'pokemonjp' && ocrJaTokens.length) {
    const need = candidatePool.filter(c => c.nameJaNorm === undefined).map(c => c.id)
    const njMap = await fetchNameJaNorm(need).catch(() => ({}))
    for (const c of candidatePool) if (c.nameJaNorm === undefined) c.nameJaNorm = njMap[c.id] ?? null
  }

  // Kombineret scoring: CLIP + phash + per-kandidat OCR number-bonus
  const w = PHASH_SCORE_WEIGHTS[safeGame] ?? PHASH_SCORE_WEIGHTS.default
  const scored = candidatePool.map(c => {
    const clip   = c.clipSim
    const ph     = c.phashDist !== null ? 1 - c.phashDist / 64 : 0
    const number = numberBonus(c.number, ocrResult)
    const name   = safeGame === 'pokemonjp'
      ? nameBonusJa(c.nameJaNorm, ocrJaTokens)
      : nameBonus(c.name, ocrName)   // navn+nummer der begge matcher = krydsvalideret → ~1.0
    const total  = usedClip
      ? clip * w.clip + ph * w.phash + number + name
      : ph * 0.75 + number + name
    return { id: c.id, total, clipSim: clip, phashSim: ph }
  }).sort((a, b) => b.total - a.total).slice(0, 5)

  const details = await fetchDetails(scored.map(c => c.id))
  const detMap  = Object.fromEntries(details.map(c => [c.id, c]))

  const candidates = scored.map(s => {
    const card = detMap[s.id] || { id: s.id }
    return {
      id:           card.id,
      name:         card.name         || null,
      number:       card.number       || null,
      set_id:       card.set_id       || null,
      set_name:     card.set_name     || null,
      rarity:       card.rarity       || null,
      finish_types: card.finish_types || ['Normal'],
      image_url:    card.image_url    || null,
      game:         card.game         || safeGame,
      similarity:   parseFloat(Math.min(s.total, 0.99).toFixed(4)),
      _clip:        parseFloat(s.clipSim.toFixed(4)),
    }
  })

  const top        = candidates[0]
  const confidence = top?.similarity >= 0.90 ? 'high' : top?.similarity >= 0.75 ? 'medium' : 'low'

  return res.status(200).json({
    candidates,
    confidence,
    best:   confidence !== 'low' ? candidates[0] : null,
    ocr:    (ocrNum || ocrName) ? { number: ocrNum, setTotal: ocrSetTotal, name: ocrName } : null,
    method: usedClip ? 'clip+phash+ocr' : 'phash+ocr',
    meta:   { game: safeGame, clip: usedClip, clipRaw: clipResultsRaw?.length ?? 0, pool: candidatePool.length, ...scanDiag },
  })
}
