/**
 * Free Scan — Node.js runtime.
 * 3-signal pipeline (høj til lav præcision):
 *   1. CLIP embedding  → pgvector cosine similarity (primær, semantisk robust)
 *   2. phash           → Hamming distance (visuelt pre-filter + fallback)
 *   3. Kortnummer OCR  → additive bonus når nummer matcher
 *
 * CLIP er robust overfor kamera-støj, vinkler og belysning.
 * phash bruges som tiebreaker og fallback når embedding endnu ikke er backfillet.
 */

import sharp     from 'sharp'
import Tesseract from 'tesseract.js'
import { MeiliSearch } from 'meilisearch'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY
const MEILI_URL    = process.env.MEILISEARCH_URL || 'http://localhost:7700'
const MEILI_KEY    = process.env.MEILISEARCH_KEY || ''

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

const VALID_GAMES = ['pokemon', 'pokemonjp', 'mtg', 'yugioh', 'onepiece', 'lorcana', 'dragonball']

// ─── phash (fallback) ──────────────────────────────────────────────────────
async function computePhash(buf) {
  const SIZE = 8
  const px = await sharp(buf).resize(SIZE + 1, SIZE, { fit: 'fill' }).grayscale().raw().toBuffer()
  let bits = ''
  for (let r = 0; r < SIZE; r++)
    for (let c = 0; c < SIZE; c++)
      bits += px[r * (SIZE + 1) + c] < px[r * (SIZE + 1) + c + 1] ? '1' : '0'
  let hex = ''
  for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16)
  return hex
}

function hammingDist(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity
  let d = 0
  for (let i = 0; i < a.length; i++) { let x = parseInt(a[i], 16) ^ parseInt(b[i], 16); while (x) { d += x & 1; x >>= 1 } }
  return d
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0
}

// ─── Kortnummer OCR ────────────────────────────────────────────────────────
let _ocrWorker = null

async function getOcrWorker() {
  if (_ocrWorker) return _ocrWorker
  _ocrWorker = await Tesseract.createWorker('eng', 1, { logger: () => {} })
  await _ocrWorker.setParameters({
    tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/-',
    tessedit_pageseg_mode:   '7',
  })
  return _ocrWorker
}

async function ocrCardNumber(imgBuf) {
  const { width, height } = await sharp(imgBuf).metadata()
  const zone = { left: Math.floor(width * 0.08), top: Math.floor(height * 0.865), width: Math.floor(width * 0.84), height: Math.floor(height * 0.075) }
  const crop = await sharp(imgBuf).extract(zone).resize({ width: 700 }).grayscale().normalize().sharpen({ sigma: 1.2 }).toBuffer()
  const w = await getOcrWorker()
  const { data } = await w.recognize(crop)
  const raw = data.text.replace(/\s+/g, '').toUpperCase()
  const slash = raw.match(/^(\d{1,4})\/(\d{1,4})$/)
  if (slash) return slash[1].replace(/^0+(?=\d)/, '') || '0'
  const num = raw.match(/^(\d{1,4})$/)
  if (num) return num[1].replace(/^0+(?=\d)/, '') || '0'
  return null
}

// ─── Supabase ─────────────────────────────────────────────────────────────
const sbh = () => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' })

async function clipSearch(embedding, game, count = 20) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_cards`, {
    method:  'POST',
    headers: sbh(),
    body:    JSON.stringify({ query_embedding: `[${embedding.join(',')}]`, game_filter: game, match_count: count }),
  })
  if (!r.ok) return null   // pgvector endnu ikke sat op → faldt tilbage til phash
  return r.json()
}

async function phashSearch(game, uploadedHash) {
  const all = []
  let offset = 0
  while (true) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/card_catalog?game=eq.${game}&phash=not.is.null&select=id,phash&limit=1000&offset=${offset}`, { headers: sbh() })
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
  const r = await fetch(`${SUPABASE_URL}/rest/v1/card_catalog?id=in.(${ids.map(id => `"${id}"`).join(',')})&select=id,name,number,set_id,set_name,rarity,finish_types,image_url,game`, { headers: sbh() })
  return r.ok ? r.json() : []
}

async function fetchByNumber(game, num) {
  if (!num) return new Set()
  const r = await fetch(`${SUPABASE_URL}/rest/v1/card_catalog?game=eq.${game}&number=eq.${encodeURIComponent(num)}&select=id&limit=30`, { headers: sbh() })
  const rows = r.ok ? await r.json() : []
  return new Set(rows.map(c => c.id))
}

// ─── Handler ───────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v)); return res.status(200).end() }
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v))
  res.setHeader('Content-Type', 'application/json')
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let body
  try {
    body = await new Promise((resolve, reject) => {
      let d = ''; req.on('data', c => d += c); req.on('end', () => resolve(JSON.parse(d))); req.on('error', reject)
    })
  } catch { return res.status(400).json({ error: 'Invalid JSON' }) }

  const { image, game, embedding: clientEmbedding } = body
  if (!image) return res.status(400).json({ error: 'image required (base64 dataURL)' })

  const safeGame = VALID_GAMES.includes(game) ? game : 'pokemon'
  const base64   = image.replace(/^data:image\/\w+;base64,/, '')
  const imgBuf   = Buffer.from(base64, 'base64')

  const normalizedBuf = await sharp(imgBuf).resize(900, null, { withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer()

  // ── Signal 1: CLIP (primær) ────────────────────────────────────────────
  let clipResults   = null
  let usedClip      = false

  if (clientEmbedding && Array.isArray(clientEmbedding) && clientEmbedding.length === 512) {
    clipResults = await clipSearch(clientEmbedding, safeGame, 20)
    if (clipResults && clipResults.length > 0) usedClip = true
  }

  // ── Signal 2: phash (fallback / tiebreaker) ────────────────────────────
  const [uploadedPhash, phashResults] = await Promise.all([
    computePhash(normalizedBuf),
    usedClip ? Promise.resolve([]) : phashSearch(safeGame, await computePhash(normalizedBuf)),
  ])

  // Byg kandidat-pool
  let candidatePool
  if (usedClip) {
    // CLIP-resultater som primær pool — tilføj phash-similarity som bonus
    candidatePool = clipResults.map(c => ({
      id:         c.id,
      clipSim:    typeof c.similarity === 'number' ? c.similarity : 0,
      phashDist:  null,   // hentes ikke fra DB i CLIP-mode (for hurtigt)
    }))
  } else {
    // Kun phash tilgængeligt (CLIP-embeddings endnu ikke backfillet)
    candidatePool = phashResults.map(c => ({
      id:         c.id,
      clipSim:    0,
      phashDist:  c.dist,
    }))
  }

  // ── Signal 3: kortnummer OCR (additive bonus) ─────────────────────────
  let ocrNum   = null
  let numberIds = new Set()
  try {
    ocrNum = await ocrCardNumber(normalizedBuf)
    if (ocrNum) numberIds = await fetchByNumber(safeGame, ocrNum)
  } catch { /* ignore */ }

  // ── Kombineret ranking ─────────────────────────────────────────────────
  const scored = candidatePool.map(c => {
    const clip   = c.clipSim                                         // 0–1  (primær)
    const ph     = c.phashDist !== null ? 1 - c.phashDist / 64 : 0  // 0–1  (sekundær)
    const number = numberIds.has(c.id) ? 0.40 : 0                   // bonus: nummer-match

    const total = usedClip
      ? clip * 0.75 + ph * 0.15 + number
      : ph   * 0.75             + number

    return { id: c.id, total, clipSim: clip, phashSim: ph }
  }).sort((a, b) => b.total - a.total).slice(0, 5)

  // Hent fuld kortdata
  const details  = await fetchDetails(scored.map(c => c.id))
  const detMap   = Object.fromEntries(details.map(c => [c.id, c]))

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

  const top       = candidates[0]
  const confidence = top?.similarity >= 0.90 ? 'high'
    : top?.similarity >= 0.75                ? 'medium'
    : 'low'

  return res.status(200).json({
    candidates,
    confidence,
    best:    confidence !== 'low' ? candidates[0] : null,
    ocr:     ocrNum ? { number: ocrNum } : null,
    method:  usedClip ? 'clip+phash+ocr' : 'phash+ocr',
    meta:    { game: safeGame, clip: usedClip, pool: candidatePool.length },
  })
}
