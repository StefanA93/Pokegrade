import Tesseract from 'tesseract.js'
import sharp from 'sharp'

let _worker = null

async function getWorker() {
  if (!_worker) {
    _worker = await Tesseract.createWorker('eng')
    await _worker.setParameters({
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 '-.",
      tessedit_pageseg_mode: '7',
    })
  }
  return _worker
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

  // Primær pipeline — invert hvis mørk baggrund (moderne SV-kort)
  const primaryBuf = isDark
    ? await sharp(base).normalize().sharpen({ sigma: 1.2 }).negate().toBuffer()
    : await sharp(base).normalize().sharpen({ sigma: 1.2 }).toBuffer()

  const worker = await getWorker()
  const { data: primary } = await worker.recognize(primaryBuf)
  const primaryText = cleanOcrText(primary.text.replace(/[^a-zA-Z0-9 '\-.]/g, '').trim())
  const primaryConf = primary.confidence / 100

  if (primaryConf < 0.25) {
    const fallbackBuf = isDark
      ? await sharp(base).normalize().sharpen({ sigma: 1.2 }).toBuffer()
      : await sharp(base).normalize().sharpen({ sigma: 1.2 }).negate().toBuffer()
    const { data: fallback } = await worker.recognize(fallbackBuf)
    const fallbackText = cleanOcrText(fallback.text.replace(/[^a-zA-Z0-9 '\-.]/g, '').trim())
    const fallbackConf = fallback.confidence / 100
    if (fallbackConf > primaryConf) return { text: fallbackText, confidence: fallbackConf }
  }

  return { text: primaryText, confidence: primaryConf }
}

// ─── Kortnummer (bund-zone) ────────────────────────────────────────────────
// Pokémon-kortnumre sidder i en lys informationsbånd for neden
// og er altid trykt i standard font — Tesseract kan læse dem pålideligt.
// Format eksempler: "054/091", "4/102", "198", "SWSH020", "sv1EN-014"

export async function extractCardNumber(imageBuffer, game = 'pokemon') {
  const { width, height } = await sharp(imageBuffer).metadata()
  const zone = cropNumberZone(width, height, game)
  if (!zone) return null

  const buf = await sharp(imageBuffer)
    .extract(zone)
    .resize({ width: 600 })
    .grayscale()
    .normalize()
    .sharpen({ sigma: 1.0 })
    .toBuffer()

  const worker = await getWorker()
  const { data } = await worker.recognize(buf)

  const raw = data.text.replace(/[^a-zA-Z0-9/\-]/g, ' ').trim()
  return parseCardNumber(raw)
}

// Parser for at udtrække kortnummer fra OCR-tekst
function parseCardNumber(raw) {
  if (!raw) return null

  // Prøv "NNN/NNN" mønster (standard moderne format)
  const slashMatch = raw.match(/(\d{1,4})\s*\/\s*\d{1,4}/)
  if (slashMatch) return slashMatch[1].replace(/^0+/, '') || '0'

  // Prøv promotional formater: "SWSH020", "SV1EN-014" etc.
  const promoMatch = raw.match(/([A-Z]{1,4}\d{2,4})/i)
  if (promoMatch) return promoMatch[1]

  // Isoleret nummer (f.eks. Base Set bottom-right)
  const numMatch = raw.match(/\b(\d{1,4})\b/)
  if (numMatch) return numMatch[1].replace(/^0+/, '') || '0'

  return null
}

// ─── Hjælpefunktioner ────────────────────────────────────────────────────────

function cleanOcrText(raw) {
  if (!raw) return ''
  let text = raw
  text = text.replace(/\s+\d*\s*HP\b.*/i, '')
  text = text.replace(/\s+\d[\d\s]*$/, '')
  const vowels = /[aeiouAEIOU]/
  const tokens = text.trim().split(/\s+/)
  let start = 0
  while (start < tokens.length - 1) {
    const t = tokens[start]
    if (t.length <= 3 && !vowels.test(t)) start++
    else break
  }
  return tokens.slice(start).join(' ').trim()
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
      const mx = Math.floor(width * 0.10)
      return { left: mx, top: Math.floor(height * 0.865), width: width - mx * 2, height: Math.floor(height * 0.075) }
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
  if (_worker) {
    await _worker.terminate()
    _worker = null
  }
}
