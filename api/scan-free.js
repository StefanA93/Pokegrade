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
      `${SUPABASE_URL}/rest/v1/card_catalog?game=eq.${game}&phash=not.is.null&select=id,phash&limit=1000&offset=${offset}`,
      { headers: sbh() }
    )
    if (!r.ok) break
    const batch = await r.json()
    all.push(...batch)
    if (batch.length < 1000) break
    offset += 1000
  }
  return all
    .map(c => ({ id: c.id, dist: hammingDist(uploadedHash, c.phash) }))
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

async function fetchByNumber(game, num, setTotal, isCode) {
  if (!num) return { exact: new Set(), numberOnly: new Set() }

  if (isCode) {
    // Alfanumerisk kode (YGO/DBS/OnePiece): præcis kode-match
    // ≤10 = rarity-varianter af samme kort → exact; >10 = for bredt → numberOnly
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/card_catalog?game=eq.${game}&number=eq.${encodeURIComponent(num)}&select=id&limit=15`,
      { headers: sbh() }
    )
    const rows = r.ok ? await r.json() : []
    if (rows.length >= 1 && rows.length <= 10) return { exact: new Set(rows.map(c => c.id)), numberOnly: new Set() }
    if (rows.length > 10)                      return { exact: new Set(),                    numberOnly: new Set(rows.map(c => c.id)) }
    return { exact: new Set(), numberOnly: new Set() }
  }

  if (setTotal) {
    // Pokemon/MTG/Lorcana: number + sætstørrelse identificerer sættet præcist
    const rpc = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_cards_number_setsize`, {
      method:  'POST',
      headers: sbh(),
      body:    JSON.stringify({ p_game: game, p_number: num, p_set_total: setTotal }),
    })
    const exactRows = rpc.ok ? await rpc.json() : []
    if (exactRows.length > 0) return { exact: new Set(exactRows.map(c => c.id)), numberOnly: new Set() }
  }

  // Nummer-only fallback (mange kort deler nummer på tværs af sæt)
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/card_catalog?game=eq.${game}&number=eq.${encodeURIComponent(num)}&select=id&limit=30`,
    { headers: sbh() }
  )
  const rows = r.ok ? await r.json() : []
  return { exact: new Set(), numberOnly: new Set(rows.map(c => c.id)) }
}

function toCandidate(card, similarity) {
  return {
    id:           card.id,
    name:         card.name         || null,
    number:       card.number       || null,
    set_id:       card.set_id       || null,
    set_name:     card.set_name     || null,
    rarity:       card.rarity       || null,
    finish_types: card.finish_types || ['Normal'],
    image_url:    card.image_url    || null,
    game:         card.game,
    similarity:   parseFloat(similarity.toFixed(4)),
    _clip:        0,
  }
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
  let clipInputBase64 = null
  try {
    const thumb = await sharp(normalizedBuf).resize(800, 800, { fit: 'inside' }).jpeg({ quality: 85 }).toBuffer()
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
  // Filtrer produkter (blister-packs, tins, booster-boxes) fra CLIP — de forurener ranking
  const clipResultsRaw = clipAll
    ? clipAll.filter(c => !String(c.id ?? '').includes('product'))
    : null

  // phash (hurtigt, kør efter parallelfasen)
  const serverPhash   = await computePhash(normalizedBuf)
  const uploadedPhash = serverPhash ?? (typeof incomingPhash === 'string' && incomingPhash.length === 16 ? incomingPhash : null)

  // ── Processér OCR-resultat ────────────────────────────────────────────────
  const ocrNum      = ocrResult?.number   ?? null
  const ocrSetTotal = ocrResult?.setTotal ?? null
  const ocrIsCode   = ocrResult?.isCode   ?? false
  let exactIds  = new Set()
  let numberIds = new Set()

  if (ocrNum) {
    const found = await fetchByNumber(safeGame, ocrNum, ocrSetTotal, ocrIsCode)
    exactIds  = found.exact
    numberIds = found.numberOnly
  }

  // ── FAST PATH: OCR giver ét entydigt kort ──────────────────────────────────
  // Pokemon 123/165, MTG 45/280, Lorcana 12/204: sætstørrelsen identificerer sættet.
  // Kortets OCR-nummer identificerer dermed kortet 100%.
  if (exactIds.size === 1) {
    const [directId] = exactIds
    const [card] = await fetchDetails([directId])
    if (card) {
      return res.status(200).json({
        candidates:  [toCandidate(card, 0.99)],
        confidence:  'high',
        best:        toCandidate(card, 0.99),
        ocr:         { number: ocrNum, setTotal: ocrSetTotal },
        method:      'ocr-direct',
        meta:        { game: safeGame, clip: false, pool: 1 },
      })
    }
  }

  // ── RARITY PATH: OCR giver 2-10 varianter (samme kort, forskellig sjældenhed) ──
  // YGO BLVO-EN042 kan eksistere i 8 rarities — CLIP + phash vælger den rigtige.
  // DBS, One Piece alt-arts, Pokemon reverse-holo varianter.
  if (exactIds.size >= 2 && exactIds.size <= 10) {
    const rarityCards = await fetchDetails([...exactIds])

    let best = null
    let bestSim = 0

    // Forsøg 1: CLIP rangerer rarities (foil-border → anderledes embedding)
    if (clipResultsRaw && clipResultsRaw.length > 0) {
      const inPool = clipResultsRaw.filter(c => exactIds.has(c.id))
      if (inPool.length > 0) {
        best    = rarityCards.find(c => c.id === inPool[0].id) ?? null
        bestSim = inPool[0].similarity ?? 0.90
      }
    }

    // Forsøg 2: phash skelner rarity (common border vs holofoil border)
    if (!best && uploadedPhash) {
      const sorted = rarityCards
        .map(c => ({ c, dist: hammingDist(uploadedPhash, c.phash) }))
        .sort((a, b) => a.dist - b.dist)
      if (sorted.length > 0) { best = sorted[0].c; bestSim = 0.88 }
    }

    // Fallback: første rarity
    if (!best) { best = rarityCards[0]; bestSim = 0.85 }

    const candidates = rarityCards.map(c =>
      ({ ...toCandidate(c, c.id === best.id ? bestSim : bestSim - 0.08), _clip: 0 })
    )

    return res.status(200).json({
      candidates,
      confidence: 'high',
      best:       { ...toCandidate(best, bestSim), _clip: 0 },
      ocr:        { number: ocrNum, setTotal: ocrSetTotal },
      method:     'ocr-rarity',
      meta:       { game: safeGame, clip: !!(clipResultsRaw?.length), pool: rarityCards.length },
    })
  }

  // ── STANDARD PATH: CLIP + phash + OCR bonus ──────────────────────────────
  // Bruges når OCR fejler eller giver for bredt et match (>10 kort).
  //
  // Fallback-hierarki (IVFFlat er sparse for kamerafoto-embeddings):
  //   1. CLIP pool ≥ 5  → brug CLIP som primær (clip*0.65 + phash*0.25)
  //   2. CLIP pool 1-4  → CLIP er for sparsom; supplér med phash-pool
  //   3. Ingen CLIP      → ren phash-only
  const MIN_CLIP_POOL = 5
  let usedClip    = false
  let clipResults = (clipResultsRaw && clipResultsRaw.length >= MIN_CLIP_POOL) ? clipResultsRaw : null

  if (clipResults) usedClip = true

  let candidatePool
  if (usedClip) {
    candidatePool = clipResults.map(c => ({
      id:        c.id,
      clipSim:   typeof c.similarity === 'number' ? c.similarity : 0,
      phashDist: uploadedPhash ? hammingDist(uploadedPhash, c.phash) : null,
    }))
  } else {
    // Ingen brugbar CLIP (embedding mangler eller IVFFlat for sparsom) → phash-only
    if (clipResultsRaw && clipResultsRaw.length > 0) {
      console.log('[scan] clip pool sparse (' + clipResultsRaw.length + '), fallback til phash')
    }
    const phashHits = uploadedPhash ? await phashSearch(safeGame, uploadedPhash) : []
    candidatePool = phashHits.map(c => ({ id: c.id, clipSim: 0, phashDist: c.dist }))
  }

  if (!candidatePool.length) {
    return res.status(200).json({
      candidates: [], confidence: 'low', best: null,
      ocr:  ocrNum ? { number: ocrNum, setTotal: ocrSetTotal } : null,
      method: 'no-candidates',
      meta:  { game: safeGame, clip: usedClip, pool: 0, ...scanDiag },
    })
  }

  // Kombineret scoring med OCR-bonus
  const w = PHASH_SCORE_WEIGHTS[safeGame] ?? PHASH_SCORE_WEIGHTS.default
  const scored = candidatePool.map(c => {
    const clip   = c.clipSim
    const ph     = c.phashDist !== null ? 1 - c.phashDist / 64 : 0
    const number = exactIds.has(c.id) ? 0.50 : numberIds.has(c.id) ? 0.20 : 0
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
      similarity:   parseFloat(s.total.toFixed(4)),
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
