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
