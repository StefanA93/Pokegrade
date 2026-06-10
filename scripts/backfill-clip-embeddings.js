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
import { pipeline, env, RawImage } from '@huggingface/transformers'
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

// ── Embedding-beregning via RawImage (korrekt Node.js format) ────────────────
async function computeEmbedding(imageUrl) {
  const model  = await getExtractor()
  const image  = await RawImage.fromURL(imageUrl)   // native Node.js image load
  const output = await model(image, { pooling: 'mean', normalize: true })
  return Array.from(output.data)                     // float32[] med 512 dimensioner
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

  let done    = 0
  let errors  = 0
  const failed = new Set()   // kortID'er med 404/permanente fejl

  while (true) {
    // Hent med stigende offset for at komme forbi failed-kort der sidder i toppen
    let offset = 0
    let rows   = []
    while (rows.length === 0) {
      const all = await fetchMissingBatch(GAME, offset)
      if (all.length === 0) { rows = null; break }          // ingenting tilbage i DB
      rows = all.filter(r => !failed.has(r.id))
      if (rows.length === 0) offset += BATCH_SIZE           // alle i batch er failed → hop frem
    }
    if (rows === null) break                                 // DB er tømt

    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      const chunk = rows.slice(i, i + CONCURRENCY)

      await Promise.all(chunk.map(async (row) => {
        try {
          const embedding = await computeEmbedding(row.image_url)
          await saveEmbedding(row.id, embedding)
          done++
        } catch (e) {
          errors++
          failed.add(row.id)
          if (errors <= 5) console.error(`\n  Fejl (${row.id}): ${e.message}`)
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
