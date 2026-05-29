import sharp from 'sharp'
import { extractCardName } from './ocr.js'
import { computePhash, phashSimilarity } from './phash.js'

export { computePhash, hammingDistance, phashSimilarity } from './phash.js'
export { extractCardName, cleanup as cleanupOCR } from './ocr.js'

export async function normalizeImage(imageBuffer, targetWidth = 800) {
  return sharp(imageBuffer)
    .resize(targetWidth, null, { withoutEnlargement: true })
    .toBuffer()
}

export async function generateThumbnail(imageBuffer, width = 200) {
  return sharp(imageBuffer)
    .resize(width, null, { withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer()
}

export async function toWebp(imageBuffer, quality = 85) {
  return sharp(imageBuffer)
    .webp({ quality })
    .toBuffer()
}

export async function scanCard(imageBuffer, { game = null, searchFn } = {}) {
  const normalized = await normalizeImage(imageBuffer)

  // Kør OCR og phash parallelt — nummer-OCR undlades (upålidelig på moderne kort)
  const [ocrResult, uploadedPhash] = await Promise.all([
    extractCardName(normalized, game || 'pokemon'),
    computePhash(normalized),
  ])

  const { text: ocrText, confidence: ocrConfidence } = ocrResult

  // Phash-prioriteret sti: selv når OCR fejler kan phash identificere kortet
  // Floor på 0.3 sikrer at phash-signalet stadig tæller selv ved dårlig OCR
  const effectiveOcrWeight = Math.max(ocrConfidence, 0.3)

  if (!ocrText || ocrText.length < 2) {
    return { candidates: [], confidence: 0, ocrText: '', autoMatched: false }
  }

  const rawCandidates = searchFn
    ? await searchFn(ocrText, { gameId: game, limit: 10 })
    : []

  // Rangér: phash er primær disambiguation-signal, søgescore er sekundær
  const ranked = rawCandidates.map(c => {
    const pHashScore    = c.phash ? phashSimilarity(uploadedPhash, c.phash) : 0.5
    const searchScore   = c._searchScore ?? 0.7
    // Phash vægtes tungere (60%) end før — specielt vigtigt for moderne kort
    const combinedScore = effectiveOcrWeight * searchScore * (0.35 + pHashScore * 0.65)
    return { ...c, _pHashScore: pHashScore, _combinedScore: combinedScore }
  }).sort((a, b) => b._combinedScore - a._combinedScore)

  const best       = ranked[0]
  const confidence = best?._combinedScore ?? 0

  // Tærskel sænket til 0.60 — phash giver tilstrækkeligt signal selv med svag OCR
  if (confidence > 0.60 && ranked.length > 0) {
    return { match: best, candidates: ranked.slice(0, 3), confidence, ocrText, autoMatched: true }
  }

  return { candidates: ranked.slice(0, 5), confidence, ocrText, autoMatched: false }
}
