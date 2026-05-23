const BUFFER_SIZE = 5
const BLUR_THRESHOLD = 80
const GLARE_THRESHOLD = 240

export class MultiFrameBuffer {
  constructor(size = BUFFER_SIZE) {
    this.size = size
    this.frames = []
  }

  add(embedding, quality) {
    if (quality < 0.5) return false
    this.frames.push(embedding)
    if (this.frames.length > this.size) this.frames.shift()
    return true
  }

  isFull() {
    return this.frames.length >= this.size
  }

  reset() {
    this.frames = []
  }

  consensus() {
    if (!this.frames.length) return null
    const dim = this.frames[0].length
    const avg = new Float32Array(dim)
    for (const frame of this.frames) {
      for (let i = 0; i < dim; i++) avg[i] += frame[i]
    }
    for (let i = 0; i < dim; i++) avg[i] /= this.frames.length

    const norm = Math.sqrt(avg.reduce((s, v) => s + v * v, 0))
    for (let i = 0; i < avg.length; i++) avg[i] /= norm

    return Array.from(avg)
  }
}

export function assessFrameQuality(canvas) {
  const ctx = canvas.getContext('2d')
  const { width, height } = canvas
  const imageData = ctx.getImageData(0, 0, width, height)
  const data = imageData.data

  let blurScore = 0
  let glarePixels = 0
  const sample = Math.min(data.length / 4, 5000)
  const step = Math.floor(data.length / 4 / sample)

  for (let i = 0; i < data.length; i += step * 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2]
    const lum = 0.299 * r + 0.587 * g + 0.114 * b
    if (lum > GLARE_THRESHOLD) glarePixels++

    if (i > 4) {
      const prev = 0.299 * data[i - 4] + 0.587 * data[i - 3] + 0.114 * data[i - 2]
      blurScore += Math.abs(lum - prev)
    }
  }

  const glareRatio = glarePixels / sample
  const blurNorm = blurScore / sample

  const quality = Math.min(1, Math.max(0,
    (blurNorm / BLUR_THRESHOLD) * 0.6 +
    (1 - glareRatio) * 0.4
  ))

  return { quality, blurNorm, glareRatio }
}
