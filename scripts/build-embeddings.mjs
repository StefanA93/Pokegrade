/**
 * build-embeddings.mjs — Generate CLIP embeddings for card_catalog
 *
 * Processes newest sets first (SV → SWSH → SM → XY → BW → older)
 * Parallel processing: 4 cards at a time
 * ~1.5s per card → ~4 cards per 1.5s → ~6 min for SV, ~8 min for SWSH
 *
 * Usage:
 *   $env:SUPABASE_SERVICE_KEY = "YOUR_KEY"
 *   node scripts/build-embeddings.mjs
 *
 *   # Only SV + SWSH (fastest, most relevant):
 *   node scripts/build-embeddings.mjs --era=sv,swsh
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

const PARALLEL = 4
const BATCH_SIZE = 50

const ERA_ORDER = ['sv', 'swsh', 'sm', 'xy', 'bw', 'hgss', 'dp', 'ex', 'neo', 'base']

const args = process.argv.slice(2)
const eraArg = args.find(a => a.startsWith('--era='))
const onlyEras = eraArg ? eraArg.replace('--era=', '').split(',') : ERA_ORDER

const HEADERS = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
}

async function fetchBatch(era, offset, limit) {
  const url = `${SUPABASE_URL}/rest/v1/card_catalog?select=id,image_url,name&embedding=is.null&game=eq.pokemon&set_id=like.${era}*&order=id.asc&offset=${offset}&limit=${limit}`
  const res = await fetch(url, { headers: HEADERS })
  if (!res.ok) throw new Error(`Fetch batch failed: ${res.status} ${await res.text()}`)
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

async function processCard(card, extractor) {
  if (!card.image_url) return false
  try {
    // Pass URL directly — transformers.js handles the download (no sharp needed)
    const output = await extractor(card.image_url, { pooling: 'mean', normalize: true })
    return await saveEmbedding(card.id, Array.from(output.data))
  } catch (e) {
    process.stdout.write(`\n  ✗ ${card.id}: ${e.message.slice(0, 60)}\n`)
    return false
  }
}

async function countEra(era) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/card_catalog?select=id&embedding=is.null&game=eq.pokemon&set_id=like.${era}*&limit=1`,
    { headers: { ...HEADERS, Prefer: 'count=exact' } }
  )
  const range = res.headers.get('content-range')
  return range ? parseInt(range.split('/')[1]) : 0
}

async function processEra(era, extractor, stats) {
  let eraDone = 0
  const failedIds = new Set()

  while (true) {
    const cards = await fetchBatch(era, 0, BATCH_SIZE)
    // Skip cards that already failed — avoids infinite loop on bad image URLs
    const pending = cards.filter(c => !failedIds.has(c.id))
    if (!pending.length) break

    for (let i = 0; i < pending.length; i += PARALLEL) {
      const chunk = pending.slice(i, i + PARALLEL)
      const results = await Promise.all(chunk.map(c => processCard(c, extractor)))

      for (let j = 0; j < chunk.length; j++) {
        if (results[j]) {
          stats.done++
          eraDone++
        } else {
          failedIds.add(chunk[j].id)
          stats.errors++
        }
      }

      const elapsed = (Date.now() - stats.startMs) / 1000
      const rate = stats.done / elapsed
      const remaining = rate > 0 ? Math.round((stats.total - stats.done) / rate) : 0
      const eta = remaining > 0 ? `ETA ~${Math.floor(remaining/60)}m${remaining%60}s` : ''
      const card = chunk[chunk.length - 1]
      process.stdout.write(`\r  [${era}] ${stats.done}/${stats.total} ✓  ${(card.name || '').slice(0,18).padEnd(18)}  ${rate.toFixed(1)}/s  ${eta}   `)
    }
  }

  return eraDone
}

async function run() {
  console.log('\nLoading CLIP model (cached after first run)...')
  const extractor = await pipeline(
    'image-feature-extraction',
    'Xenova/clip-vit-base-patch32',
    {
      progress_callback: ({ status, name, progress }) => {
        if (status === 'progress' && progress) process.stdout.write(`\r  ${name} ${Math.round(progress)}%   `)
      }
    }
  )
  console.log('\n✓ Model ready.\n')

  // Count remaining per era
  console.log('Counting cards needing embeddings...')
  let total = 0
  const eraCounts = {}
  for (const era of onlyEras) {
    const n = await countEra(era)
    eraCounts[era] = n
    total += n
    if (n > 0) console.log(`  ${era.padEnd(6)} ${n.toLocaleString()} cards`)
  }
  console.log(`  ──────────────`)
  console.log(`  Total  ${total.toLocaleString()} cards`)
  console.log(`\nParallel: ${PARALLEL} cards at a time (~${Math.round(1.5/PARALLEL*1000)}ms per card)`)
  console.log(`Estimated time: ~${Math.round(total * 1.5 / PARALLEL / 60)} minutes\n`)

  const stats = { done: 0, errors: 0, total, startMs: Date.now() }

  for (const era of onlyEras) {
    if (!eraCounts[era]) { console.log(`  Skipping ${era} (0 remaining)`); continue }
    console.log(`\nProcessing ${era} (${eraCounts[era]} cards)...`)
    const n = await processEra(era, extractor, stats)
    console.log(`\n  ✓ ${era}: ${n} done`)
  }

  const elapsed = Math.round((Date.now() - stats.startMs) / 1000)
  console.log(`\n${'─'.repeat(50)}`)
  console.log(`Done in ${Math.floor(elapsed/60)}m ${elapsed%60}s`)
  console.log(`✓ ${stats.done.toLocaleString()} embeddings generated`)
  if (stats.errors) console.log(`✗ ${stats.errors} errors`)
}

run().catch(e => { console.error('\n', e); process.exit(1) })
