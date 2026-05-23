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
