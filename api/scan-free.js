/**
 * Free Scan endpoint — Node.js runtime (ikke Edge, da vi bruger sharp + Tesseract).
 *
 * 3-signal pipeline:
 *   1. phash        → visual pre-filter: top 50 visuelle kandidater fra DB
 *   2. Kortnummer   → OCR på nummerzonen (NNN/TTT) — maskinlæsbar font, ~70% præcision på rigtige fotos
 *   3. Meilisearch  → tekst-search på navn/nummer hvis OCR giver noget
 *
 * Kombineret ranking giver markant bedre top-1 end phash alene.
 */

import sharp     from 'sharp'
import Tesseract from 'tesseract.js'
import { MeiliSearch } from 'meilisearch'

const SUPABASE_URL      = process.env.SUPABASE_URL
const SUPABASE_KEY      = process.env.SUPABASE_SERVICE_KEY
const MEILISEARCH_URL   = process.env.MEILISEARCH_URL  || 'http://localhost:7700'
const MEILISEARCH_KEY   = process.env.MEILISEARCH_KEY  || ''

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

const VALID_GAMES = ['pokemon', 'pokemonjp', 'mtg', 'yugioh', 'onepiece', 'lorcana', 'dragonball']

// ─── Perceptuelt hash (dHash 8×8 = 64-bit) ────────────────────────────────
async function computePhash(buf) {
  const SIZE = 8
  const pixels = await sharp(buf)
    .resize(SIZE + 1, SIZE, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer()

  let bits = ''
  for (let row = 0; row < SIZE; row++) {
    for (let col = 0; col < SIZE; col++) {
      const i = row * (SIZE + 1) + col
      bits += pixels[i] < pixels[i + 1] ? '1' : '0'
    }
  }
  let hex = ''
  for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16)
  return hex
}

function hammingDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity
  let dist = 0
  for (let i = 0; i < a.length; i++) {
    let xor = parseInt(a[i], 16) ^ parseInt(b[i], 16)
    while (xor) { dist += xor & 1; xor >>= 1 }
  }
  return dist
}

// ─── Kortnummer OCR ────────────────────────────────────────────────────────
let _worker = null

async function getOcrWorker() {
  if (_worker) return _worker
  _worker = await Tesseract.createWorker('eng', 1, { logger: () => {} })
  await _worker.setParameters({
    tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/-',
    tessedit_pageseg_mode:   '7',   // Enkelt linje
  })
  return _worker
}

function parseCardNumber(raw) {
  if (!raw) return null
  const clean = raw.replace(/\s+/g, '').toUpperCase()

  // Format: NNN/TTT → returnér tæller-delen
  const slash = clean.match(/^(\d{1,4})\/(\d{1,4})$/)
  if (slash) return { num: slash[1].replace(/^0+(?=\d)/, '') || '0', total: slash[2] }

  // Promotional: SWSH020, SVP114, OP01-001, LED5-EN020 etc.
  const promo = clean.match(/^([A-Z]{2,5})\d{2,4}(?:-[A-Z]{0,2}\d{2,3})?$/)
  if (promo) return { num: clean, total: null }

  // Kun nummer
  const only = clean.match(/^(\d{1,4})$/)
  if (only) return { num: only[1].replace(/^0+(?=\d)/, '') || '0', total: null }

  return null
}

async function extractCardNumber(imgBuf, game) {
  const { width, height } = await sharp(imgBuf).metadata()

  // Nummerzonen: Pokémon 86-94% af højden, MTG 86-94%, resten lignende
  const top    = Math.floor(height * 0.865)
  const zone   = { left: Math.floor(width * 0.08), top, width: Math.floor(width * 0.84), height: Math.floor(height * 0.075) }

  const cropBuf = await sharp(imgBuf)
    .extract(zone)
    .resize({ width: 700 })
    .grayscale()
    .normalize()
    .sharpen({ sigma: 1.2 })
    .toBuffer()

  const worker = await getOcrWorker()
  const { data } = await worker.recognize(cropBuf)
  return parseCardNumber(data.text.trim())
}

// ─── Supabase helpers ──────────────────────────────────────────────────────
const sbHeaders = () => ({
  apikey:        SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
})

async function fetchAllPhashes(game) {
  const all  = []
  const PAGE = 1000
  let offset = 0
  while (true) {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/card_catalog?game=eq.${game}&phash=not.is.null&select=id,phash&limit=${PAGE}&offset=${offset}`,
      { headers: sbHeaders() }
    )
    if (!r.ok) break
    const batch = await r.json()
    all.push(...batch)
    if (batch.length < PAGE) break
    offset += PAGE
  }
  return all
}

async function fetchCardDetails(ids) {
  if (!ids.length) return []
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/card_catalog?id=in.(${ids.map(id => `"${id}"`).join(',')})&select=id,name,number,set_id,set_name,rarity,finish_types,image_url,game`,
    { headers: sbHeaders() }
  )
  if (!r.ok) return []
  return r.json()
}

async function fetchByNumber(game, num, total) {
  if (!num) return []
  let params = `game=eq.${game}&number=eq.${encodeURIComponent(num)}&select=id,name,number,set_id,set_name,rarity,finish_types,image_url,game&limit=20`
  const r = await fetch(`${SUPABASE_URL}/rest/v1/card_catalog?${params}`, { headers: sbHeaders() })
  if (!r.ok) return []
  const rows = await r.json()
  // Hvis vi har total (NNN/TTT), filtrer på sæt med samme antal kort
  return rows
}

// ─── Meilisearch søgning ───────────────────────────────────────────────────
let _meili = null
function getMeili() {
  if (!_meili) _meili = new MeiliSearch({ host: MEILISEARCH_URL, apiKey: MEILISEARCH_KEY })
  return _meili
}

async function meiliSearch(query, game, limit = 10) {
  try {
    const res = await getMeili().index('cards').search(query, {
      limit,
      filter: game ? [`gameId = ${game}`] : [],
      attributesToRetrieve: ['id', 'name', 'number', 'setName', 'rarity', 'finishTypes', 'thumbKey', 'phash'],
      showRankingScore: true,
    })
    return res.hits.map(h => ({ ...h, _searchScore: h._rankingScore ?? 0.5 }))
  } catch { return [] }
}

// ─── Kombineret ranking ────────────────────────────────────────────────────
// Princip: phash er primær. OCR + Meilisearch er KUN additive bonusser.
// En kandidat kan aldrig falde pga. OCR — kun stige hvis nummer matcher.
function rankCandidates({ phashCandidates, numberCandidates, meiliCandidates }) {
  const numberIds = new Set(numberCandidates.map(c => c.id))
  const meiliMap  = new Map(meiliCandidates.map(c => [c.id, c._searchScore ?? 0.5]))

  return phashCandidates.map(c => {
    const phashSim    = Math.max(0, 1 - c.dist / 64)
    const numberBonus = numberIds.has(c.id) ? 0.50 : 0          // stærk bekræftelse
    const meiliBonus  = (meiliMap.get(c.id) ?? 0) * 0.10        // svag tekst-boost
    const total       = phashSim + numberBonus + meiliBonus

    return {
      id:      c.id,
      dist:    c.dist,
      total,
      sources: {
        phash:  phashSim,
        number: numberBonus,
        meili:  meiliBonus,
      },
    }
  }).sort((a, b) => b.total - a.total)
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
  try { body = await new Promise((resolve, reject) => {
    let data = ''
    req.on('data', chunk => data += chunk)
    req.on('end', () => resolve(JSON.parse(data)))
    req.on('error', reject)
  }) } catch { return res.status(400).json({ error: 'Invalid JSON' }) }

  const { image, game, clientPhash } = body

  if (!image || typeof image !== 'string') return res.status(400).json({ error: 'image required (base64 dataURL)' })

  const safeGame = VALID_GAMES.includes(game) ? game : 'pokemon'

  // Afkod base64 billede
  const base64 = image.replace(/^data:image\/\w+;base64,/, '')
  const imgBuf = Buffer.from(base64, 'base64')

  // Resize til max 900px bredde for konsistent hashing
  const normalizedBuf = await sharp(imgBuf)
    .resize(900, null, { withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer()

  // ── Signal 1: phash ──────────────────────────────────────────────────────
  const [uploadedPhash, allPhashes] = await Promise.all([
    computePhash(normalizedBuf),
    fetchAllPhashes(safeGame),
  ])

  const phashRanked = allPhashes
    .map(c => ({ id: c.id, dist: hammingDistance(uploadedPhash, c.phash) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 50)   // Top 50 visuelle kandidater

  // ── Signal 2: Kortnummer OCR ─────────────────────────────────────────────
  let numberResult = null
  let numberCandidates = []
  try {
    numberResult = await extractCardNumber(normalizedBuf, safeGame)
    if (numberResult?.num) {
      numberCandidates = await fetchByNumber(safeGame, numberResult.num, numberResult.total)
    }
  } catch { /* OCR fejlede — fortsæt uden */ }

  // ── Signal 3: Meilisearch (nummer-søgning hvis vi har det) ───────────────
  let meiliCandidates = []
  if (numberResult?.num) {
    meiliCandidates = await meiliSearch(numberResult.num, safeGame, 10)
  }

  // ── Kombiner og rank ──────────────────────────────────────────────────────
  const ranked = rankCandidates({ phashCandidates: phashRanked, numberCandidates, meiliCandidates, uploadedPhash })
  const top5ids = ranked.slice(0, 5).map(r => r.id)

  // Hent fuld kortdata for top 5
  const details  = await fetchCardDetails(top5ids)
  const detMap   = Object.fromEntries(details.map(c => [c.id, c]))

  const candidates = ranked.slice(0, 5).map(r => {
    const card = detMap[r.id] || { id: r.id }
    const phashEntry = phashRanked.find(p => p.id === r.id)
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
      similarity:   phashEntry ? parseFloat((1 - phashEntry.dist / 64).toFixed(4)) : 0,
      score:        parseFloat(r.total.toFixed(4)),
      signals:      r.sources,
    }
  })

  // Confidence: høj hvis nummer-match bekræfter phash top-1
  const top = candidates[0]
  const numberConfirmed = top?.signals?.number > 0
  const highPhash       = top?.similarity >= 0.85

  const confidence = numberConfirmed ? 'high'
    : highPhash                      ? 'high'
    : top?.score >= 0.35             ? 'medium'
    : 'low'

  return res.status(200).json({
    candidates,
    confidence,
    best:       confidence !== 'low' ? candidates[0] : null,
    ocr:        numberResult ? { number: numberResult.num, total: numberResult.total } : null,
    phash:      uploadedPhash,
    meta:       { game: safeGame, pool: allPhashes.length, signals: { phash: phashRanked.length, number: numberCandidates.length, meili: meiliCandidates.length } },
  })
}
