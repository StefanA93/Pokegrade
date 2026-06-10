/**
 * Server-side CLIP embedding extractor (Node.js).
 * Bruger @huggingface/transformers med sharp til billedforbehandling.
 * Model: Xenova/clip-vit-base-patch32 — 512-dimensionelle embeddings.
 */
import { pipeline, RawImage, env } from '@huggingface/transformers'
import sharp from 'sharp'

env.allowLocalModels = false

let _model = null

async function getModel() {
  if (!_model) {
    _model = await pipeline('image-feature-extraction', 'Xenova/clip-vit-base-patch32', {
      dtype: 'fp32',
    })
  }
  return _model
}

export async function extractEmbedding(imageBuffer) {
  const model = await getModel()

  // Sharp → raw RGB pixel data → RawImage (Node.js safe, ingen data-URL)
  const { data, info } = await sharp(imageBuffer)
    .resize(224, 224, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const image  = new RawImage(new Uint8ClampedArray(data), info.width, info.height, 3)
  const output = await model(image, { pooling: 'mean', normalize: true })
  return Array.from(output.data)
}

export async function isEmbeddingAvailable() {
  try {
    await getModel()
    return true
  } catch {
    return false
  }
}
