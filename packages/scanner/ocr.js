import Tesseract from 'tesseract.js'
import sharp from 'sharp'

let _worker    = null
let _numWorker = null

async function getWorker() {
  if (!_worker) {
    _worker = await Tesseract.createWorker('eng', 1, { logger: () => {} })
    await _worker.setParameters({
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 '-.",
      tessedit_pageseg_mode: '7',
    })
  }
  return _worker
}

async function getNumWorker() {
  if (!_numWorker) {
    _numWorker = await Tesseract.createWorker('eng', 1, { logger: () => {} })
    await _numWorker.setParameters({
      tessedit_char_whitelist: '0123456789/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz -',
      tessedit_pageseg_mode: '7',
    })
  }
  return _numWorker
}

// ─── Kortnavne (top-zone) ──────────────────────────────────────────────────

export async function extractCardName(imageBuffer, game = 'pokemon') {
  const { width, height } = await sharp(imageBuffer).metadata()
  const zone = cropNameZone(width, height, game)

  const base = await sharp(imageBuffer)
    .extract(zone)
    .resize({ width: 700 })
    .grayscale()
    .toBuffer()

  const stats  = await sharp(base).stats()
  const isDark = stats.channels[0].mean < 110

  const worker = await getWorker()

  // Forsøg 4 preprocessing-varianter og tag den med højest confidence
  const pipelines = [
    // 1. Adaptiv binarisering via threshold — bedst mod foil/holografisk baggrund
    sharp(base).threshold(isDark ? 80 : 160).negate(isDark ? false : { greyscale: false }).toBuffer(),
    // 2. CLAHE-lignende: normalize → sharpen → threshold
    sharp(base).normalize().sharpen({ sigma: 1.5 }).threshold(140).toBuffer(),
    // 3. Inverteret threshold — mørke bogstaver på lys baggrund
    sharp(base).negate().normalize().threshold(130).toBuffer(),
    // 4. Blød normalize uden threshold — fallback til original pipeline
    isDark
      ? sharp(base).normalize().sharpen({ sigma: 1.2 }).negate().toBuffer()
      : sharp(base).normalize().sharpen({ sigma: 1.2 }).toBuffer(),
  ]

  const results = await Promise.all(
    (await Promise.all(pipelines)).map(buf => worker.recognize(buf))
  )

  let best = { text: '', confidence: 0 }
  for (const { data } of results) {
    const text = cleanOcrText(data.text.replace(/[^a-zA-Z0-9 '\-.]/g, '').trim())
    const conf = data.confidence / 100
    if (conf > best.confidence && text.length >= 2) best = { text, confidence: conf }
  }

  return { text: best.text, confidence: best.confidence }
}

// ─── Kortnummer (bund-zone) ────────────────────────────────────────────────
// Pokémon-kortnumre sidder i en lys informationsbånd for neden
// og er altid trykt i standard font — Tesseract kan læse dem pålideligt.
// Format eksempler: "054/091", "4/102", "198", "SWSH020", "sv1EN-014"

export async function extractCardNumber(imageBuffer, game = 'pokemon') {
  const { width, height } = await sharp(imageBuffer).metadata()
  const zone = cropNumberZone(width, height, game)
  if (!zone) return null

  const base = await sharp(imageBuffer)
    .extract(zone)
    .resize({ width: 900 })
    .grayscale()
    .toBuffer()

  const stats  = await sharp(base).stats()
  const isDark = stats.channels[0].mean < 110

  const pipelines = [
    sharp(base).normalize().threshold(isDark ? 80 : 150).toBuffer(),
    sharp(base).normalize().negate().threshold(130).toBuffer(),
    sharp(base).normalize().sharpen({ sigma: 1.2 }).threshold(160).toBuffer(),
  ]

  const worker = await getNumWorker()
  const bufs   = await Promise.all(pipelines)
  const texts  = await Promise.all(bufs.map(b => worker.recognize(b).then(r => r.data.text)))

  for (const text of texts) {
    const raw    = text.replace(/[^a-zA-Z0-9/\-]/g, ' ').trim()
    const result = parseCardNumber(raw)
    if (result?.reliable) return result.num
  }
  return null
}

// Parser for at udtrække kortnummer fra OCR-tekst
function parseCardNumber(raw) {
  if (!raw) return null

  // NNN/NNN mønster — standard moderne format, høj pålidelighed
  const slashMatch = raw.match(/(\d{1,4})\s*\/\s*(\d{1,4})/)
  if (slashMatch) {
    const num   = slashMatch[1].replace(/^0+/, '') || '0'
    const total = parseInt(slashMatch[2], 10)
    // Kun pålidelig hvis total er et realistisk sæt-antal (≥ 20)
    if (total >= 20) return { num, reliable: true }
  }

  // Promotional formater: "SWSH020", "SV1EN-014" etc.
  const promoMatch = raw.match(/([A-Z]{2,4}\d{2,4})/i)
  if (promoMatch) return { num: promoMatch[1], reliable: true }

  // Isoleret nummer — lavere pålidelighed (kan være pokédex-nr, år o.l.)
  const numMatch = raw.match(/\b(\d{2,4})\b/)
  if (numMatch) return { num: numMatch[1].replace(/^0+/, '') || '0', reliable: false }

  return null
}

// ─── Hjælpefunktioner ────────────────────────────────────────────────────────

const VALID_SUFFIXES = new Set(['ex', 'EX', 'V', 'VSTAR', 'VMAX', 'GX', 'TAG', 'TEAM', 'UNION'])

function cleanOcrText(raw) {
  if (!raw) return ''
  let text = raw
  text = text.replace(/\s+\d*\s*HP\b.*/i, '')
  const vowels = /[aeiouAEIOU]/
  const tokens = text.trim().split(/\s+/)

  let start = 0
  while (start < tokens.length - 1) {
    const t = tokens[start]
    if (t.length <= 3 && !VALID_SUFFIXES.has(t)) start++
    else break
  }

  // Strip trailing noise: short tokens containing digits that aren't valid card suffixes
  let end = tokens.length
  while (end > start + 1) {
    const t = tokens[end - 1]
    if (!VALID_SUFFIXES.has(t) && /\d/.test(t)) end--
    else break
  }

  // Limit to max 3 tokens — card names are never longer
  const sliced = tokens.slice(start, Math.min(end, start + 3))
  return sliced.join(' ').trim()
}

function cropNameZone(width, height, game) {
  const mx = Math.floor(width * 0.08)
  const iw = width - mx * 2
  switch (game) {
    case 'yugioh':  return { left: mx, top: Math.floor(height * 0.01), width: iw, height: Math.floor(height * 0.09) }
    case 'mtg':     return { left: mx, top: Math.floor(height * 0.06), width: iw, height: Math.floor(height * 0.09) }
    case 'lorcana': return { left: mx, top: Math.floor(height * 0.60), width: iw, height: Math.floor(height * 0.09) }
    default:        return { left: mx, top: Math.floor(height * 0.03), width: iw, height: Math.floor(height * 0.11) }
  }
}

function cropNumberZone(width, height, game) {
  // Pokémon: nummeret sidder i informationsbåndet for neden (ca. 86-94% af højden)
  // Typisk i midten af kortet, lidt til venstre. Vi tager en bred stribe.
  switch (game) {
    case 'pokemon': {
      const mx = Math.floor(width * 0.05)
      return { left: mx, top: Math.floor(height * 0.920), width: width - mx * 2, height: Math.floor(height * 0.060) }
    }
    case 'mtg': {
      const mx = Math.floor(width * 0.05)
      return { left: mx, top: Math.floor(height * 0.86), width: width - mx * 2, height: Math.floor(height * 0.07) }
    }
    default:
      return null
  }
}

export async function cleanup() {
  await Promise.all([
    _worker    ? _worker.terminate().then(() => { _worker = null })    : null,
    _numWorker ? _numWorker.terminate().then(() => { _numWorker = null }) : null,
  ])
}
