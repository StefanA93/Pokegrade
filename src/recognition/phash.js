/**
 * Client-side perceptuelt hash (dHash 8×8 = 64-bit).
 * Identisk algoritme med packages/scanner/phash.js — men bruger Canvas i stedet for sharp.
 * Kører i browseren på microsekunder uden server-roundtrip.
 *
 * Brug:
 *   import { computePhash, hammingDistance, phashSimilarity } from './recognition/phash.js'
 *   const hash = await computePhash(imageDataUrl)
 *   const sim  = phashSimilarity(hash, cardFromDb.phash)
 */

const HASH_SIZE = 8

/**
 * Beregner dHash fra et billede (dataURL eller URL).
 * Returnerer 16 hex-tegn (64 bits).
 */
export async function computePhash(imageSource) {
  const img = new Image()
  img.crossOrigin = 'anonymous'

  await new Promise((resolve, reject) => {
    img.onload  = resolve
    img.onerror = reject
    img.src     = imageSource
  })

  const canvas = document.createElement('canvas')
  canvas.width  = HASH_SIZE + 1   // 9 kolonner — differens-hash sammenligner pixel med naboen
  canvas.height = HASH_SIZE       // 8 rækker

  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(img, 0, 0, HASH_SIZE + 1, HASH_SIZE)

  const { data } = ctx.getImageData(0, 0, HASH_SIZE + 1, HASH_SIZE)

  let bits = ''
  for (let row = 0; row < HASH_SIZE; row++) {
    for (let col = 0; col < HASH_SIZE; col++) {
      const i = (row * (HASH_SIZE + 1) + col) * 4       // venstre pixel
      const j = (row * (HASH_SIZE + 1) + col + 1) * 4  // højre pixel (nabo)

      // Konvertér til gråskala (BT.601 luma)
      const L = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114
      const R = data[j] * 0.299 + data[j + 1] * 0.587 + data[j + 2] * 0.114

      bits += L < R ? '1' : '0'
    }
  }

  let hex = ''
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16)
  }
  return hex  // altid 16 hex-tegn
}

/**
 * Hamming-distance mellem to phash-strenge (lavere = mere ens).
 * Returnerer Infinity hvis hashene er ugyldige eller har forskellig længde.
 */
export function hammingDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity
  let dist = 0
  for (let i = 0; i < a.length; i++) {
    let xor = parseInt(a[i], 16) ^ parseInt(b[i], 16)
    while (xor) { dist += xor & 1; xor >>= 1 }
  }
  return dist
}

/**
 * Similarity 0–1 (1 = identisk, 0 = helt forskellig).
 * < 0.80: forskelligt kort
 * ≥ 0.80: mulig match (verificér visuelt)
 * ≥ 0.90: sandsynligt match
 * ≥ 0.95: næsten sikkert match
 */
export function phashSimilarity(a, b) {
  const dist = hammingDistance(a, b)
  if (dist === Infinity) return 0
  return 1 - dist / (HASH_SIZE * HASH_SIZE)
}
