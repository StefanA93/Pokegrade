/**
 * Kortnummer-OCR til Railway (varm proces — Tesseract-worker preloades ved startup,
 * ingen cold start pr. request). Returnerer { number, setTotal, isCode } — samme form
 * som scan-free forventer, så fast-path (exact-id) og number-bonus virker.
 */
import Tesseract from 'tesseract.js'
import sharp from 'sharp'

let _worker = null

export async function getOcrWorker() {
  if (_worker) return _worker
  _worker = await Tesseract.createWorker('eng', 1, { logger: () => {} })
  await _worker.setParameters({
    tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/-',
    tessedit_pageseg_mode:   '6',   // uniform block — læser nummerbåndet (PSM 7 fejlede)
  })
  return _worker
}

const EMPTY = { number: null, setTotal: null, isCode: false }

// \d{1,3} (ikke {1,4}) så et efterfølgende copyright-år (fx "006/195 2022") ikke
// smitter setTotal til "1952". setTotal valideres til et realistisk sæt-antal.
function trySlash(raw) {
  const m = raw.match(/(\d{1,3})\s*\/\s*(\d{1,3})/)
  if (!m) return null
  const total = parseInt(m[2], 10)
  if (total < 10 || total > 400) return null
  return { number: m[1].replace(/^0+(?=\d)/, '') || '0', setTotal: total, isCode: false }
}
function tryCode(raw) {
  const m = raw.match(/([A-Z]{2,6}\d{0,3}-[A-Z]{0,2}\d{2,4})/)
  return m ? { number: m[1], setTotal: null, isCode: true } : null
}
function tryBare(raw) {
  const m = raw.match(/\b(\d{1,4})\b/)
  return m ? { number: m[1].replace(/^0+(?=\d)/, '') || '0', setTotal: null, isCode: false } : null
}

// Spil-bevidst rækkefølge: kode-spil (YGO/DBS/One Piece) prøver kode først;
// resten (Pokemon/MTG/Lorcana) prøver slash først, så støjet OCR ikke
// fejl-parses som en YGO-kode (fx "11/68" → "ESR-N11").
function parseOcrText(raw, game) {
  const codeGame = game === 'yugioh' || game === 'dragonball' || game === 'onepiece'
  if (codeGame) return tryCode(raw) || trySlash(raw) || tryBare(raw) || EMPTY
  return trySlash(raw) || tryBare(raw) || tryCode(raw) || EMPTY
}

export async function ocrCardNumber(imgBuf, game = 'pokemon') {
  let base
  try {
    const { width, height } = await sharp(imgBuf).metadata()
    // Kortnummeret sidder i den NEDERSTE stribe (~92-99% af højden), ikke i
    // weakness/resistance-rækken (~86%). Fuld bredde dækker både venstre (moderne)
    // og højre (WOTC-æra) placering.
    const zone = {
      left:   Math.floor(width  * 0.03),
      top:    Math.floor(height * 0.920),
      width:  Math.floor(width  * 0.94),
      height: Math.floor(height * 0.075),
    }
    base = await sharp(imgBuf).extract(zone).resize({ width: 1000 }).grayscale().normalize().toBuffer()
  } catch {
    base = imgBuf
  }

  const w = await getOcrWorker()
  // To varianter: skarpt positiv + inverteret (lyse tal på mørkt bånd)
  const bufs = await Promise.all([
    sharp(base).sharpen({ sigma: 1.5 }).toBuffer(),
    sharp(base).sharpen({ sigma: 1.5 }).negate().toBuffer(),
  ])

  let fallback = { number: null, setTotal: null, isCode: false }
  for (const b of bufs) {
    const { data } = await w.recognize(b)
    const raw = data.text.replace(/\s+/g, '').toUpperCase()
    const parsed = parseOcrText(raw, game)
    // Pålidelig: alfanumerisk kode, eller slash-format med realistisk sæt-total
    if (parsed.isCode || (parsed.setTotal && parsed.setTotal >= 20)) return parsed
    if (parsed.number && !fallback.number) fallback = parsed
  }
  return fallback
}
