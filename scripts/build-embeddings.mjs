/**
 * build-embeddings.mjs — Generate CLIP embeddings for all cards in card_catalog
 * and store them in Supabase pgvector column.
 *
 * Prerequisites:
 *   1. Enable pgvector in Supabase (run SQL from docs/pgvector-migration.sql)
 *   2. npm install @huggingface/transformers --ignore-scripts
 *
 * Usage:
 *   $env:SUPABASE_SERVICE_KEY = "YOUR_KEY"
 *   node scripts/build-embeddings.mjs
 *
 * First run downloads CLIP model (~170MB). Subsequent runs use cache.
 * Processes ~500 cards/hour. Skip cards that already have embeddings.
 */

import { pipeline, env } from '@huggingface/transformers'

env.allowLocalModels = false
env.cacheDir = './.cache/transformers'

const SUPABASE_URL = 'https://yezlcgooutpshqdhvufg.supabase.co'
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

if (!SUPABASE_SERVICE_KEY) {
  console.error('Set SUPABASE_SERVICE_KEY env var.')
  process.exit(1)
}

const HEADERS = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
}

const BATCH_SIZE = 10
const DELAY_MS = 500

async function fetchCards(offset = 0, limit = 100) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/card_catalog?select=id,image_url,name&embedding=is.null&game=eq.pokemon&order=id.asc&offset=${offset}&limit=${limit}`,
    { headers: HEADERS }
  )
  if (!res.ok) throw new Error(`Supabase fetch failed: ${res.status}`)
  return res.json()
}

async function saveEmbedding(cardId, embedding) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/card_catalog?id=eq.${encodeURIComponent(cardId)}`,
    {
      method: 'PATCH',
      headers: { ...HEADERS, Prefer: 'return=minimal' },
      body: JSON.stringify({ embedding: `[${embedding.join(',')}]` }),
    }
  )
  return res.ok
}

async function fetchImageAsDataUrl(url) {
  const res = await fetch(url)
  if (!res.ok) return null
  const buf = await res.arrayBuffer()
  const b64 = Buffer.from(buf).toString('base64')
  const mime = res.headers.get('content-type') || 'image/png'
  return `data:${mime};base64,${b64}`
}

async function run() {
  console.log('Loading CLIP model (first run downloads ~170MB)...')
  let lastProgress = ''
  const extractor = await pipeline(
    'image-feature-extraction',
    'Xenova/clip-vit-base-patch32',
    {
      progress_callback: ({ status, name, progress }) => {
        const msg = `  ${status} ${name || ''} ${progress ? Math.round(progress) + '%' : ''}`
        if (msg !== lastProgress) { console.log(msg); lastProgress = msg }
      }
    }
  )
  console.log('Model loaded.\n')

  let offset = 0
  let total = 0
  let errors = 0

  while (true) {
    const cards = await fetchCards(offset, BATCH_SIZE)
    if (!cards.length) break

    for (const card of cards) {
      if (!card.image_url) { errors++; continue }

      try {
        const dataUrl = await fetchImageAsDataUrl(card.image_url)
        if (!dataUrl) { errors++; continue }

        const output = await extractor(dataUrl, { pooling: 'mean', normalize: true })
        const embedding = Array.from(output.data)

        const ok = await saveEmbedding(card.id, embedding)
        if (ok) {
          total++
          console.log(`✓ [${total}] ${card.id} — ${card.name}`)
        } else {
          console.log(`✗ failed to save: ${card.id}`)
          errors++
        }

        await new Promise(r => setTimeout(r, DELAY_MS))
      } catch (e) {
        console.error(`✗ ${card.id}: ${e.message}`)
        errors++
      }
    }

    offset += BATCH_SIZE
  }

  console.log(`\nDone. ✓ ${total} embeddings generated. ✗ ${errors} errors.`)
}

run().catch(e => { console.error(e); process.exit(1) })
