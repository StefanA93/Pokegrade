/**
 * Backfiller manglende CLIP embeddings for kort uden embedding i card_catalog.
 * Bruger Xenova/clip-vit-base-patch32 (512-dim) via @huggingface/transformers.
 *
 * Kør: node scripts/backfill-embeddings.js [game]
 * Eksempel: node scripts/backfill-embeddings.js pokemon
 *           node scripts/backfill-embeddings.js all
 */
import 'dotenv/config'
import { extractEmbedding } from '../packages/scanner/embedding-server.js'
import { dbSelect, dbUpdate } from '../server/middleware/db.js'

const GAME       = process.argv[2] || 'pokemon'
const GAMES      = ['pokemon', 'yugioh', 'mtg', 'lorcana', 'onepiece', 'dragonball', 'pokemonjp']
const BATCH_DB   = 200
const BATCH_UPS  = 50
const CONCUR     = 3
const DL_TIMEOUT = 15000

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function downloadImage(url) {
  const ctrl = new AbortController()
  const t    = setTimeout(() => ctrl.abort(), DL_TIMEOUT)
  try {
    const r = await fetch(url, { signal: ctrl.signal })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return Buffer.from(await r.arrayBuffer())
  } finally {
    clearTimeout(t)
  }
}

async function processGame(game) {
  console.log(`\n🔮 CLIP embedding backfill — ${game}`)

  // Model pre-loading
  process.stdout.write('  Loader CLIP-model...')
  await extractEmbedding(Buffer.alloc(100)) // warm-up (vil fejle på tom buffer, men loader model)
    .catch(() => {})
  console.log(' klar\n')

  let offset = 0, done = 0, errors = 0

  while (true) {
    const rows = await dbSelect(
      'card_catalog',
      `game=eq.${game}&image_url=not.is.null&embedding=is.null&select=id,image_url&limit=${BATCH_DB}&offset=${offset}`
    )
    if (!rows.length) break

    const queue   = [...rows]
    const updates = []

    while (queue.length) {
      const batch   = queue.splice(0, CONCUR)
      const results = await Promise.all(batch.map(async row => {
        try {
          const buf       = await downloadImage(row.image_url)
          const embedding = await extractEmbedding(buf)
          return { id: row.id, embedding: JSON.stringify(embedding) }
        } catch {
          return null
        }
      }))

      for (const r of results) {
        if (r) updates.push(r)
        else   errors++
      }
    }

    for (const update of updates) {
      try {
        await dbUpdate('card_catalog', { id: update.id }, { embedding: update.embedding })
        done++
      } catch (err) {
        process.stderr.write(`\n  PATCH fejl (${update.id}): ${err.message.slice(0, 60)}\n`)
        errors++
      }
    }

    offset += rows.length
    process.stdout.write(`\r  ${done} embeddings gemt | ${errors} fejl | offset ${offset}`)
    await sleep(100)
  }

  console.log(`\n  ✅ ${game}: ${done} embeddings gemt, ${errors} fejl`)
}

async function run() {
  const targets = GAME === 'all' ? GAMES : [GAME]
  if (!GAMES.includes(GAME) && GAME !== 'all') {
    console.error(`Ukendt spil: ${GAME}. Gyldige: ${GAMES.join(', ')}, all`)
    process.exit(1)
  }
  for (const g of targets) await processGame(g)
  console.log('\nFærdig!')
}

run().catch(err => { console.error(err); process.exit(1) })
