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

  // Sharp → raw RGB pixel data → RawImage (Node.js safe, ingen data-URL).
  // VIGTIGT: ingen resize her — CLIP-processoren laver selv resize(224)+center-crop,
  // præcis som backfill (RawImage.fromURL). Et manuelt stretch til 224x224 forvrænger
  // aspect ratio og giver embeddings der IKKE flugter med kataloget (cosine 0.85 vs 1.0).
  // withoutEnlargement + fit:inside kun som memory-guard for ekstremt store billeder.
  const { data, info } = await sharp(imageBuffer)
    .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
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
