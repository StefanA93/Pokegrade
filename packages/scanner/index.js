import sharp from 'sharp'
import { extractCardName, extractCardNumber } from './ocr.js'
import { computePhash, computeArtworkPhash, phashSimilarity } from './phash.js'
import { searchByEmbedding } from '../search/index.js'

export { computePhash, computeArtworkPhash, hammingDistance, phashSimilarity } from './phash.js'
export { extractCardName, extractCardNumber, cleanup as cleanupOCR } from './ocr.js'
export { extractEmbedding, isEmbeddingAvailable } from './embedding-server.js'

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

function scoreByPhash(candidate, fullPhash, artPhash) {
  const artScore  = candidate.phashArt ? phashSimilarity(artPhash, candidate.phashArt)  : 0
  const fullScore = candidate.phash    ? phashSimilarity(fullPhash, candidate.phash)    : 0
  if (artScore > 0 && fullScore > 0) return artScore * 0.65 + fullScore * 0.35
  if (artScore > 0) return artScore
  if (fullScore > 0) return fullScore
  return 0.5
}

export async function scanCard(imageBuffer, { game = null, searchFn, embeddingFn } = {}) {
  const normalized = await normalizeImage(imageBuffer)
  const g          = game || 'pokemon'

  // ── Parallelle signaler ───────────────────────────────────────────────────
  const [ocrResult, cardNum, fullPhash, artPhash] = await Promise.all([
    extractCardName(normalized, g),
    extractCardNumber(normalized, g),
    computePhash(normalized),
    computeArtworkPhash(normalized, g),
  ])

  const { text: ocrText, confidence: ocrConfidence } = ocrResult

  // ── Vej 1: Kortnummer (hurtigste, mest præcis) ────────────────────────────
  // extractCardNumber returnerer kun reliable numre (NNN/NNN mønster).
  // Filter på numberInt → kun ~20-40 kandidater → phash artwork disambiguerer sæt.
  // Returnerer KUN hvis phash-confidence er høj (≥ 0.75) for at undgå falske positiver.
  if (cardNum && searchFn) {
    const numInt = parseInt(cardNum, 10)
    if (Number.isFinite(numInt) && numInt > 0) {
      const numCandidates = await searchFn('', { gameId: g, numberInt: numInt, limit: 40 })

      if (numCandidates.length > 0) {
        const ranked = numCandidates.map(c => ({
          ...c,
          _pHashScore:    scoreByPhash(c, fullPhash, artPhash),
          _combinedScore: scoreByPhash(c, fullPhash, artPhash),
        })).sort((a, b) => b._combinedScore - a._combinedScore)

        const best = ranked[0]
        // Høj tærskel: phash skal være meget sikker når nummer alene disambiguerer
        if (best._combinedScore >= 0.75) {
          return {
            match:       best,
            candidates:  ranked.slice(0, 5),
            confidence:  best._combinedScore,
            ocrText,
            cardNum,
            method:      'number+phash',
            autoMatched: best._combinedScore >= 0.82,
          }
        }
      }
    }
  }

  // ── Vej 2: CLIP embedding (visuelt fingeraftryk, sæt-uafhængigt) ──────────
  // 512-dim cosine similarity over hele kataloget via pgvector.
  // Kombineres med artwork-phash for final disambiguering.
  const ef = embeddingFn || (typeof extractEmbeddingLazy !== 'undefined' ? extractEmbeddingLazy : null)
  if (ef) {
    try {
      const embedding       = await ef(normalized)
      const embCandidates   = await searchByEmbedding(embedding, g, 15, 0.60)

      if (embCandidates.length > 0) {
        const ranked = embCandidates.map(c => {
          const pHash    = scoreByPhash(c, fullPhash, artPhash)
          const embScore = typeof c.similarity === 'number' ? c.similarity : 0.7
          const combined = embScore * 0.65 + pHash * 0.35
          return { ...c, _pHashScore: pHash, _combinedScore: combined }
        }).sort((a, b) => b._combinedScore - a._combinedScore)

        const best = ranked[0]
        if (best._combinedScore > 0.65) {
          return {
            match:       best,
            candidates:  ranked.slice(0, 5),
            confidence:  best._combinedScore,
            ocrText,
            cardNum,
            method:      'embedding+phash',
            autoMatched: best._combinedScore > 0.72,
          }
        }
      }
    } catch {
      // Embedding-fejl er ikke fatale — fortsæt til navnesøgning
    }
  }

  // ── Vej 3: Navnesøgning (fallback) ────────────────────────────────────────
  if (!ocrText || ocrText.length < 2) {
    return { candidates: [], confidence: 0, ocrText: '', cardNum, method: 'none', autoMatched: false }
  }

  const effectiveOcrWeight = Math.max(ocrConfidence, 0.3)
  const rawCandidates = searchFn
    ? await searchFn(ocrText, { gameId: g, limit: 10 })
    : []

  const ranked = rawCandidates.map(c => {
    const pHash       = scoreByPhash(c, fullPhash, artPhash)
    const searchScore = c._searchScore ?? 0.7
    const combined    = effectiveOcrWeight * searchScore * (0.35 + pHash * 0.65)
    return { ...c, _pHashScore: pHash, _combinedScore: combined }
  }).sort((a, b) => b._combinedScore - a._combinedScore)

  const best       = ranked[0]
  const confidence = best?._combinedScore ?? 0

  if (confidence > 0.60 && ranked.length > 0) {
    return { match: best, candidates: ranked.slice(0, 3), confidence, ocrText, cardNum, method: 'name+phash', autoMatched: true }
  }

  return { candidates: ranked.slice(0, 5), confidence, ocrText, cardNum, method: 'name+phash', autoMatched: false }
}
