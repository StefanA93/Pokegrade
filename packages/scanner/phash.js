import sharp from 'sharp'

const HASH_SIZE = 8

export async function computePhash(imageBuffer) {
  const pixels = await sharp(imageBuffer)
    .resize(HASH_SIZE + 1, HASH_SIZE, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer()

  let bits = ''
  for (let row = 0; row < HASH_SIZE; row++) {
    for (let col = 0; col < HASH_SIZE; col++) {
      const idx = row * (HASH_SIZE + 1) + col
      bits += pixels[idx] < pixels[idx + 1] ? '1' : '0'
    }
  }

  let hex = ''
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16)
  }
  return hex
}

function artworkZone(width, height, game) {
  const mx = Math.floor(width * 0.08)
  const iw = width - mx * 2
  switch (game) {
    case 'yugioh':
      return { left: mx, top: Math.floor(height * 0.12), width: iw, height: Math.floor(height * 0.44) }
    case 'mtg':
      return { left: mx, top: Math.floor(height * 0.13), width: iw, height: Math.floor(height * 0.37) }
    case 'lorcana':
      return { left: mx, top: Math.floor(height * 0.08), width: iw, height: Math.floor(height * 0.42) }
    case 'onepiece':
      return { left: mx, top: Math.floor(height * 0.08), width: iw, height: Math.floor(height * 0.46) }
    default:
      return { left: mx, top: Math.floor(height * 0.14), width: iw, height: Math.floor(height * 0.52) }
  }
}

export async function computeArtworkPhash(imageBuffer, game = 'pokemon') {
  const meta = await sharp(imageBuffer).metadata()
  const zone = artworkZone(meta.width, meta.height, game)
  const cropped = await sharp(imageBuffer).extract(zone).toBuffer()
  return computePhash(cropped)
}

export function hammingDistance(hashA, hashB) {
  if (!hashA || !hashB || hashA.length !== hashB.length) return Infinity
  let dist = 0
  for (let i = 0; i < hashA.length; i++) {
    const a = parseInt(hashA[i], 16)
    const b = parseInt(hashB[i], 16)
    let xor = a ^ b
    while (xor) { dist += xor & 1; xor >>= 1 }
  }
  return dist
}

export function phashSimilarity(hashA, hashB) {
  const maxDist = HASH_SIZE * HASH_SIZE
  const dist = hammingDistance(hashA, hashB)
  if (dist === Infinity) return 0
  return 1 - dist / maxDist
}
