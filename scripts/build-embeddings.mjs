/**
 * build-embeddings.mjs — Generate CLIP embeddings for card_catalog
 *
 * Processes newest sets first (SV → SWSH → SM → XY → BW → older)
 * Parallel processing: 4 cards at a time
 *
 * Usage:
 *   $env:SUPABASE_SERVICE_KEY = "YOUR_KEY"
 *   node scripts/build-embeddings.mjs
 *
 *   # Only SV + SWSH (fastest, most relevant):
 *   node scripts/build-embeddings.mjs --era sv,swsh
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

// Priority order: newest sets first
const ERA_ORDER = ['sv', 'swsh', 'sm', 'xy', 'bw', 'hgss', 'dp', 'ex', 'neo', 'base', 'other']

const args = process.argv.slice(2)
const eraArg = args.find(a => a.startsWith('--era='))
const onlyEras = eraArg ? eraArg.replace('--era=', '').split(',') : null

const HEADERS = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
}

async function fetchBatch(era, offset, limit) {
  let url
  if (era === 'other') {
    const knownPrefixes = ERA_ORDER.slice(0, -1).map(e => `set_id=not.like.${e}*`).join('&')
    url = `${SUPABASE_URL}/rest/v1/card_catalog?select=id,image_url,name&embedding=is.null&game=eq.pokemon&order=id.asc&offset=${offset}&limit=${limit}`
  } else {
    url = `${SUPABASE_URL}/rest/v1/card_catalog?select=id,image_url,name&embedding=is.null&game=eq.pokemon&set_id=like.${era}*&order=id.asc&offset=${offset}&limit=${limit}`
  }
  const res = await fetch(url, { headers: HEADERS })
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`)
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
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    const buf = await res.arrayBuffer()
    const b64 = Buffer.from(buf).toString('base64')
    const mime = res.headers.get('content-type') || 'image/png'
    return `data:${mime};base64,${b64}`
  } catch {
    return null
  }
}

async function processCard(card, extractor) {
  if (!card.image_url) return { ok: false, reason: 'no_image' }
  const dataUrl = await fetchImageAsDataUrl(card.image_url)
  if (!dataUrl) return { ok: false, reason: 'fetch_failed' }
  try {
    const output = await extractor(dataUrl, { pooling: 'mean', normalize: true })
    const ok = await saveEmbedding(card.id, Array.from(output.data))
    return { ok, reason: ok ? null : 'save_failed' }
  } catch (e) {
    return { ok: false, reason: e.message }
  }
}

async function processEra(era, extractor, stats) {
  let offset = 0
  let eraTotal = 0

  while (true) {
    const cards = await fetchBatch(era, offset, BATCH_SIZE)
    if (!cards.length) break

    // Process PARALLEL cards at a time
    for (let i = 0; i < cards.length; i += PARALLEL) {
      const chunk = cards.slice(i, i + PARALLEL)
      const results = await Promise.all(chunk.map(c => processCard(c, extractor)))

      for (let j = 0; j < chunk.length; j++) {
        const card = chunk[j]
        const result = results[j]
        if (result.ok) {
          stats.done++
          eraTotal++
          const elapsed = (Date.now() - stats.startMs) / 1000
          const rate = stats.done / elapsed
          const remaining = stats.total > 0 ? Math.round((stats.total - stats.done) / rate) : '?'
          const eta = remaining !== '?' ? `ETA ~${Math.floor(remaining / 60)}m ${remaining % 60}s` : ''
          process.stdout.write(`\r✓ ${stats.done}/${stats.total} [${era}] ${card.name.slice(0, 20).padEnd(20)} ${eta}   `)
        } else {
          stats.errors++
        }
      }
    }

    offset += BATCH_SIZE
  }

  return eraTotal
}

async function countTotal(eras) {
  let total = 0
  for (const era of eras) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/card_catalog?select=id&embedding=is.null&game=eq.pokemon${era !== 'other' ? `&set_id=like.${era}*` : ''}&limit=1`,
      { headers: { ...HEADERS, Prefer: 'count=exact' } }
    )
    const range = res.headers.get('content-range')
    const n = range ? parseInt(range.split('/')[1]) : 0
    total += n
  }
  return total
}

async function run() {
  const eras = onlyEras ?? ERA_ORDER

  console.log(`\n🔍 Loading CLIP model (cached after first run)...`)
  let lastMsg = ''
  const extractor = await pipeline(
    'image-feature-extraction',
    'Xenova/clip-vit-base-patch32',
    {
      progress_callback: ({ status, name, progress }) => {
        const msg = `  ${status} ${name || ''} ${progress ? Math.round(progress) + '%' : ''}`
        if (msg !== lastMsg) { process.stdout.write('\r' + msg.padEnd(60)); lastMsg = msg }
      }
    }
  )
  console.log('\n✓ Model ready.\n')

  console.log(`Counting cards needing embeddings...`)
  const total = await countTotal(eras)
  console.log(`Found ${total.toLocaleString()} cards to process across eras: ${eras.join(', ')}`)
  console.log(`Parallel: ${PARALLEL} cards at a time\n`)

  const stats = { done: 0, errors: 0, total, startMs: Date.now() }

  for (const era of eras) {
    if (onlyEras && !onlyEras.includes(era)) continue
    const n = await processEra(era, extractor, stats)
    if (n > 0) console.log(`\n  ↳ ${era}: ${n} done`)
  }

  const elapsed = Math.round((Date.now() - stats.startMs) / 1000)
  console.log(`\n\nDone in ${Math.floor(elapsed / 60)}m ${elapsed % 60}s`)
  console.log(`✓ ${stats.done} embeddings generated`)
  console.log(`✗ ${stats.errors} errors`)
}

run().catch(e => { console.error('\n', e); process.exit(1) })
