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

export async function scanCard(imageBuffer, { game = null, searchFn, candidatePhashes = [] } = {}) {
  const normalized = await normalizeImage(imageBuffer)
  const [ocrResult, uploadedPhash] = await Promise.all([
    extractCardName(normalized, game || 'pokemon'),
    computePhash(normalized)
  ])

  const { text: ocrText, confidence: ocrConfidence } = ocrResult

  if (!ocrText || ocrText.length < 2) {
    return { candidates: [], confidence: 0, ocrText: '', autoMatched: false }
  }

  const rawCandidates = searchFn ? await searchFn(ocrText, { gameId: game, limit: 5 }) : []

  const ranked = rawCandidates.map(c => {
    const pHashScore = c.phash ? phashSimilarity(uploadedPhash, c.phash) : 0.5
    const combinedScore = ocrConfidence * (c._searchScore ?? 0.8) * (0.4 + pHashScore * 0.6)
    return { ...c, _pHashScore: pHashScore, _combinedScore: combinedScore }
  }).sort((a, b) => b._combinedScore - a._combinedScore)

  const best = ranked[0]
  const confidence = best?._combinedScore ?? 0

  if (confidence > 0.75 && ranked.length > 0) {
    return { match: best, candidates: ranked.slice(0, 3), confidence, ocrText, autoMatched: true }
  }

  return { candidates: ranked.slice(0, 3), confidence, ocrText, autoMatched: false }
}
