/**
 * Backfill CLIP embeddings for alle kort i card_catalog.
 * Bruger Xenova/clip-vit-base-patch32 via @huggingface/transformers (kører i Node.js via ONNX).
 *
 * Krav: kør supabase-clip-migration.sql FØR dette script.
 *
 * Brug:
 *   node scripts/backfill-clip-embeddings.js pokemon
 *   node scripts/backfill-clip-embeddings.js mtg
 *   node scripts/backfill-clip-embeddings.js yugioh
 *   node scripts/backfill-clip-embeddings.js          (alle spil)
 *
 * Estimeret tid (CPU): ~300ms/kort → 40K kort ≈ 3 timer (paralleliseret: ~45 min)
 * Genoptager automatisk fra embedding=is.null
 */

import 'dotenv/config'
import { pipeline, env } from '@huggingface/transformers'
import { dbSelect, dbUpdate, dbCount } from '../server/middleware/db.js'

// ── Konfiguration ─────────────────────────────────────────────────────────────
const GAME        = process.argv[2] || null          // null = alle spil
const CONCURRENCY = 4                                // parallelle CLIP-kald
const BATCH_SIZE  = 50                               // kort pr. DB-hentning
const TIMEOUT_MS  = 20000
const DELAY_MS    = 100                              // pause mellem batches

// ── CLIP model ────────────────────────────────────────────────────────────────
env.allowLocalModels = false

let _extractor = null

async function getExtractor() {
  if (_extractor) return _extractor
  process.stdout.write('Indlæser CLIP-model (Xenova/clip-vit-base-patch32)...')
  _extractor = await pipeline(
    'image-feature-extraction',
    'Xenova/clip-vit-base-patch32',
    { device: 'cpu' }
  )
  console.log(' ✅')
  return _extractor
}

// ── Billede-download ──────────────────────────────────────────────────────────
async function fetchImageAsDataUrl(url) {
  const ctrl = new AbortController()
  const t    = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(url, { signal: ctrl.signal })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const buf    = Buffer.from(await r.arrayBuffer())
    const mime   = r.headers.get('content-type') || 'image/jpeg'
    return `data:${mime};base64,${buf.toString('base64')}`
  } finally {
    clearTimeout(t)
  }
}

// ── Embedding-beregning ───────────────────────────────────────────────────────
async function computeEmbedding(imageUrl) {
  const model  = await getExtractor()
  const dataUrl = await fetchImageAsDataUrl(imageUrl)
  const output  = await model(dataUrl, { pooling: 'mean', normalize: true })
  return Array.from(output.data)   // float32[] med 512 dimensioner
}

// ── Supabase patch (embedding som pgvector-format) ───────────────────────────
async function saveEmbedding(cardId, embedding) {
  const vectorStr = `[${embedding.join(',')}]`
  await dbUpdate('card_catalog', { id: cardId }, { embedding: vectorStr })
}

// ── Hent kort der mangler embedding ──────────────────────────────────────────
async function fetchMissingBatch(game, offset) {
  const gameFilter = game ? `game=eq.${game}&` : ''
  return dbSelect(
    'card_catalog',
    `${gameFilter}embedding=is.null&image_url=not.is.null&select=id,image_url&limit=${BATCH_SIZE}&offset=${offset}`
  )
}

// ── Hjælper: sleep ────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ── Hoved-loop ────────────────────────────────────────────────────────────────
async function run() {
  const gameFilter = GAME ? `game=eq.${GAME}&` : ''
  const total = await dbCount('card_catalog', `${gameFilter}embedding=is.null&image_url=not.is.null`)

  console.log(`\n🧠 CLIP Embedding Backfill`)
  console.log(`   Spil:      ${GAME || 'alle'}`)
  console.log(`   Mangler:   ${total} kort`)
  console.log(`   Model:     Xenova/clip-vit-base-patch32 (512-dim)\n`)

  if (total === 0) {
    console.log('✅ Alle kort har allerede embeddings!')
    return
  }

  // Pre-load model
  await getExtractor()

  let done   = 0
  let errors = 0
  let offset = 0

  while (true) {
    const rows = await fetchMissingBatch(GAME, 0)  // offset=0 da processerede forsvinder fra embedding=is.null
    if (!rows.length) break

    // Paralleliser i chunks af CONCURRENCY
    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      const chunk = rows.slice(i, i + CONCURRENCY)

      await Promise.all(chunk.map(async (row) => {
        try {
          const embedding = await computeEmbedding(row.image_url)
          await saveEmbedding(row.id, embedding)
          done++
        } catch {
          errors++
        }
      }))

      const pct = total > 0 ? ((done / total) * 100).toFixed(1) : '?'
      process.stdout.write(`\r  [${done + errors}/${total}] (${pct}%) gemt: ${done} | fejl: ${errors}`)
    }

    await sleep(DELAY_MS)
  }

  // Afsluttende status
  const remaining = await dbCount('card_catalog', `${gameFilter}embedding=is.null&image_url=not.is.null`)
  const embedded  = await dbCount('card_catalog', `${gameFilter}embedding=not.is.null`)

  console.log(`\n\n✅ Færdig!`)
  console.log(`   Embeddings gemt:  ${done}`)
  console.log(`   Fejl:             ${errors}`)
  console.log(`   Resterende:       ${remaining}`)
  console.log(`   Total i DB:       ${embedded}`)
  console.log(`\n➡  Kør nu i Supabase SQL Editor:`)
  console.log(`   reindex index card_catalog_embedding_idx;`)
}

run().catch(err => { console.error(err); process.exit(1) })
