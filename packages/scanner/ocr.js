import Tesseract from 'tesseract.js'
import sharp from 'sharp'

let _worker = null

async function getWorker() {
  if (!_worker) {
    _worker = await Tesseract.createWorker('eng')
    await _worker.setParameters({
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 \'-.',
      tessedit_pageseg_mode: '7',
    })
  }
  return _worker
}

export async function extractCardName(imageBuffer, game = 'pokemon') {
  const { width, height } = await sharp(imageBuffer).metadata()

  const nameZone = cropNameZone(width, height, game)
  const croppedBuffer = await sharp(imageBuffer)
    .extract(nameZone)
    .resize({ width: 600 })
    .sharpen()
    .normalize()
    .grayscale()
    .toBuffer()

  const worker = await getWorker()
  const { data } = await worker.recognize(croppedBuffer)

  const text   = data.text.replace(/[^a-zA-Z0-9 '\-\.]/g, '').trim()
  const confidence = data.confidence / 100

  return { text, confidence }
}

function cropNameZone(width, height, game) {
  switch (game) {
    case 'yugioh':
      return { left: 0, top: 0,                                width, height: Math.floor(height * 0.09) }
    case 'mtg':
      return { left: 0, top: Math.floor(height * 0.05),        width, height: Math.floor(height * 0.1) }
    case 'lorcana':
      return { left: 0, top: Math.floor(height * 0.60),        width, height: Math.floor(height * 0.1) }
    default:
      return { left: 0, top: 0,                                width, height: Math.floor(height * 0.12) }
  }
}

export async function cleanup() {
  if (_worker) {
    await _worker.terminate()
    _worker = null
  }
}
