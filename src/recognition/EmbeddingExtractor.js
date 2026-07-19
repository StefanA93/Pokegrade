import { pipeline, env } from '@huggingface/transformers'

env.allowLocalModels = false
env.useBrowserCache = true

let extractor = null
let loadPromise = null

export async function loadEmbeddingModel(onProgress) {
  if (extractor) return extractor
  if (loadPromise) return loadPromise

  loadPromise = pipeline(
    'image-feature-extraction',
    'Xenova/clip-vit-base-patch32',
    { progress_callback: onProgress }
  ).then(model => {
    extractor = model
    loadPromise = null
    return model
  })

  return loadPromise
}

export function isModelLoaded() {
  return extractor !== null
}

export async function extractEmbeddingFromCanvas(canvas) {
  const model = await loadEmbeddingModel()

  const resized = document.createElement('canvas')
  resized.width = 224
  resized.height = 224
  resized.getContext('2d').drawImage(canvas, 0, 0, 224, 224)

  const imageUrl = resized.toDataURL('image/jpeg', 0.92)
  const output = await model(imageUrl, { pooling: 'mean', normalize: true })

  return Array.from(output.data)
}

export async function extractEmbeddingFromDataUrl(dataUrl) {
  const model = await loadEmbeddingModel()
  const output = await model(dataUrl, { pooling: 'mean', normalize: true })
  return Array.from(output.data)
}

// Kunst-region embedding (client-side fallback). Crop til kunst-vinduet FØR CLIP — SAMME vindue som
// katalog (scripts/backfill-yugioh-art.mjs) + scan-servicen (embedding-server.js) så cosine flugter.
// YGO-kort er tekst-dominerede → kunst-region tredobler kort-ID. Bruges kun når Railway-arten mangler.
export async function extractArtEmbeddingFromDataUrl(dataUrl) {
  const model = await loadEmbeddingModel()
  const img = await new Promise((resolve, reject) => {
    const i = new Image()
    i.onload = () => resolve(i)
    i.onerror = reject
    i.src = dataUrl
  })
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height
  const cw = Math.max(1, Math.round(w * 0.84)), ch = Math.max(1, Math.round(h * 0.35))
  const c = document.createElement('canvas')
  c.width = cw; c.height = ch
  c.getContext('2d').drawImage(img, Math.round(w * 0.08), Math.round(h * 0.155), cw, ch, 0, 0, cw, ch)
  const output = await model(c.toDataURL('image/jpeg', 0.92), { pooling: 'mean', normalize: true })
  return Array.from(output.data)
}
