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

// ─── Supabase ─────────────────────────────────────────────────────────────
const sbh = () => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' })

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
      `${SUPABASE_URL}/rest/v1/card_catalog?game=eq.${game}&phash=not.is.null&number=not.like.product-*&select=id,number,phash&limit=1000&offset=${offset}`,
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
    .map(c => ({ id: c.id, number: c.number ?? null, dist: hammingDist(uploadedHash, c.phash) }))
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
    const a = cand.raw.replace(/[^A-Z0-9]/g, '')
    const b = String(ocr.number).toUpperCase().replace(/[^A-Z0-9]/g, '')
    return a && b && a === b ? 0.55 : 0
  }
  if (cand.num == null || cand.num !== String(ocr.number)) return 0
  if (ocr.setTotal && cand.total) return cand.total === ocr.setTotal ? 0.55 : 0.12  // total skelner base vs base2
  return 0.30
}

// Auto-crop (v2): estimér baggrundsfarve fra de 4 hjørner, masker pixels der AFVIGER fra den
// (= kortet), og beskær via række/kolonne-profiler. Håndterer ensartede baggrunde i ENHVER farve
// (grå/hvid/sort/farvet bord) — modsat saturation (v1) der fejlede på farvede baggrunde.
// Ægte fotos har baggrund → uden crop ser CLIP kortet i forkert skala → forkerte matches.
// No-op hvis kortet allerede fylder rammen (clean renders → hjørner = kort → intet afviger nok).
async function autoCropCard(buf) {
  try {
    const W = 140
    const { data, info } = await sharp(buf).resize(W, W, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true })
    const w = info.width, h = info.height, ch = info.channels
    const at = (x, y) => { const i = (y * w + x) * ch; return [data[i], data[i + 1], data[i + 2]] }
    let br = 0, bg = 0, bb = 0, bn = 0   // baggrundsfarve = gennemsnit af 4 hjørne-patches
    for (const [cx, cy] of [[3, 3], [w - 4, 3], [3, h - 4], [w - 4, h - 4]])
      for (let dy = -3; dy < 3; dy++) for (let dx = -3; dx < 3; dx++) { const [r, g, b] = at(cx + dx, cy + dy); br += r; bg += g; bb += b; bn++ }
    br /= bn; bg /= bn; bb /= bn
    const rowP = new Array(h).fill(0), colP = new Array(w).fill(0)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const [r, g, b] = at(x, y)
      if (Math.abs(r - br) + Math.abs(g - bg) + Math.abs(b - bb) > 60) { rowP[y]++; colP[x]++ }
    }
    const band = (prof, len) => { const th = len * 0.18; let a = 0, b = len - 1; while (a < len && prof[a] < th) a++; while (b > a && prof[b] < th) b--; return [a, b] }
    const [ry0, ry1] = band(rowP, w), [cx0, cx1] = band(colP, h)
    const bw = cx1 - cx0, bh = ry1 - ry0, frac = (bw * bh) / (w * h)
    if (bw < w * 0.2 || bh < h * 0.2 || frac > 0.55) return buf   // kort fylder allerede ≥55% → ingen crop (undgå at skære clean renders)
    const meta = await sharp(buf).metadata(), pad = 0.02
    const L = Math.max(0, Math.floor((cx0 / w - pad) * meta.width))
    const T = Math.max(0, Math.floor((ry0 / h - pad) * meta.height))
    const R = Math.min(meta.width, Math.ceil((cx1 / w + pad) * meta.width))
    const B = Math.min(meta.height, Math.ceil((ry1 / h + pad) * meta.height))
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
    normalizedBuf = await sharp(imgBuf).resize(900).jpeg({ quality: 90 }).toBuffer()
  } catch { normalizedBuf = imgBuf }

  const matchCount = CLIP_MATCH_COUNT[safeGame] ?? CLIP_MATCH_COUNT.default

  // ── Parallel: Railway embedding + OCR kører samtidigt ────────────────────
  // Prioritet: Railway (server-side, altid stabil) > client-CLIP (WASM, upålidelig)
  // VIGTIGT: bevar aspect ratio (fit:inside) — IKKE stretch. Railway/CLIP-processoren
  // laver selv resize(224)+center-crop, præcis som backfill. Stretch gav cosine 0.85
  // mod kataloget (skulle være ~1.0) → forkerte matches.
  // 800px giver nok opløsning til at Railway-OCR kan læse kortnummeret (embedding nedskalerer selv).
  // Auto-crop kortet ud af baggrunden FØR embedding/OCR — så kortet fylder rammen som i kataloget.
  let clipInputBase64 = null
  try {
    const cropped = await autoCropCard(normalizedBuf)
    const thumb = await sharp(cropped).resize(800, 800, { fit: 'inside' }).jpeg({ quality: 85 }).toBuffer()
    clipInputBase64 = thumb.toString('base64')
  } catch { clipInputBase64 = normalizedBuf.toString('base64') }

  // Ét VARMT Railway-kald returnerer BÅDE embedding og OCR. Erstatter Vercels
  // cold-start-Tesseract (som tog ~11s → "server error"). Nu ~1-2s.
  const scanDiag = { thumbLen: clipInputBase64?.length ?? 0, embedUrlOk: !!EMBED_URL }
  const _t0Rwy = Date.now()
  const railway = await getServerEmbedding(clipInputBase64, safeGame)
  scanDiag.railwayMs = Date.now() - _t0Rwy
  scanDiag.railwayOk = !!railway?.embedding
  const railwayEmbedding = railway?.embedding ?? null
  const ocrResult = railway?.ocr ?? null

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
      number:    c.number ?? null,
      clipSim:   typeof c.similarity === 'number' ? c.similarity : 0,
      phashDist: uploadedPhash ? hammingDist(uploadedPhash, c.phash) : null,
    }))
  } else {
    // Ingen brugbar CLIP (embedding mangler eller IVFFlat for sparsom) → phash-only
    if (clipResultsRaw && clipResultsRaw.length > 0) {
      console.log('[scan] clip pool sparse (' + clipResultsRaw.length + '), fallback til phash')
    }
    const phashHits = uploadedPhash ? await phashSearch(safeGame, uploadedPhash) : []
    candidatePool = phashHits.map(c => ({ id: c.id, number: c.number ?? null, clipSim: 0, phashDist: c.dist }))
  }

  if (!candidatePool.length) {
    return res.status(200).json({
      candidates: [], confidence: 'low', best: null,
      ocr:  ocrNum ? { number: ocrNum, setTotal: ocrSetTotal } : null,
      method: 'no-candidates',
      meta:  { game: safeGame, clip: usedClip, pool: 0, ...scanDiag },
    })
  }

  // Kombineret scoring: CLIP + phash + per-kandidat OCR number-bonus
  const w = PHASH_SCORE_WEIGHTS[safeGame] ?? PHASH_SCORE_WEIGHTS.default
  const scored = candidatePool.map(c => {
    const clip   = c.clipSim
    const ph     = c.phashDist !== null ? 1 - c.phashDist / 64 : 0
    const number = numberBonus(c.number, ocrResult)
    const total  = usedClip
      ? clip * w.clip + ph * w.phash + number
      : ph * 0.75 + number
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
    ocr:    ocrNum ? { number: ocrNum, setTotal: ocrSetTotal } : null,
    method: usedClip ? 'clip+phash+ocr' : 'phash+ocr',
    meta:   { game: safeGame, clip: usedClip, clipRaw: clipResultsRaw?.length ?? 0, pool: candidatePool.length, ...scanDiag },
  })
}
