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

// Kunst-region embedding: tekst/vandmærke-tunge kort har svag hele-kort-embedding; illustrationen er den
// diskriminative del. Crop til kunst-vinduet FØR CLIP. Vinduet er SPIL-BEVIDST — layouts varierer:
//  - YGO (default): monster-kunst-vindue (tekst-domineret kort, lille kunst).
//  - One Piece: øvre karakter-region (0.06-0.40) der UNDGÅR "SAMPLE"-vandmærket på Bandais katalogbilleder
//    (validering: hele-kort→øvre-crop løftede OP retrieval top-1 30%→49%, top-5 49%→65%).
// SAMME crop bruges ved katalog-backfill OG scan-tid (begge via denne funktion) så embeddings flugter.
// Kombineres 0.5/0.5 med hele-kort i match_cards_combined.
const ART_WINDOWS = {
  onepiece: { l: 0.05, t: 0.06, w: 0.90, h: 0.34 },
  default:  { l: 0.08, t: 0.155, w: 0.84, h: 0.35 },
}
export async function extractArtEmbedding(imageBuffer, game) {
  const model = await getModel()
  const meta = await sharp(imageBuffer).metadata()
  const w = meta.width || 1, h = meta.height || 1
  const win = ART_WINDOWS[game] || ART_WINDOWS.default
  const region = {
    left:   Math.round(w * win.l),
    top:    Math.round(h * win.t),
    width:  Math.max(1, Math.round(w * win.w)),
    height: Math.max(1, Math.round(h * win.h)),
  }
  const { data, info } = await sharp(imageBuffer).extract(region).removeAlpha().raw().toBuffer({ resolveWithObject: true })
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
