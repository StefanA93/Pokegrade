/**
 * Beregner phash_art (artwork-zone perceptual hash) for alle kort med billeder.
 * Artwork-zonen er den unikke illustration — fungerer som kortets visuelle fingeraftryk.
 * Meget mere diskriminativ end fuld-kortet phash.
 *
 * Kør: node scripts/backfill-artwork-phash.js [game]
 * Eksempel: node scripts/backfill-artwork-phash.js pokemon
 *           node scripts/backfill-artwork-phash.js all
 */
import 'dotenv/config'
import { computeArtworkPhash } from '../packages/scanner/phash.js'
import { dbSelect, dbUpdate } from '../server/middleware/db.js'

const GAME       = process.argv[2] || 'pokemon'
const GAMES      = ['pokemon', 'yugioh', 'mtg', 'lorcana', 'onepiece', 'dragonball', 'pokemonjp', 'riftbound']
const BATCH_DB   = 200
const CONCUR     = 4
const DL_TIMEOUT = 12000

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function patchWithRetry(id, phash_art) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await dbUpdate('card_catalog', { id }, { phash_art })
      return true
    } catch (err) {
      if (attempt === 3) throw err
      await sleep(500 * Math.pow(2, attempt))
    }
  }
}

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
  console.log(`\n🎨 Artwork phash backfill — ${game}`)
  let offset = 0, done = 0, skipped = 0, errors = 0

  while (true) {
    const rows = await dbSelect(
      'card_catalog',
      `game=eq.${game}&image_url=not.is.null&phash_art=is.null&select=id,image_url&limit=${BATCH_DB}&offset=${offset}`
    )
    if (!rows.length) break

    const queue   = [...rows]
    const updates = []

    while (queue.length) {
      const batch   = queue.splice(0, CONCUR)
      const results = await Promise.all(batch.map(async row => {
        try {
          const buf  = await downloadImage(row.image_url)
          const hash = await computeArtworkPhash(buf, game)
          return { id: row.id, phash_art: hash }
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
        await patchWithRetry(update.id, update.phash_art)
        done++
      } catch (err) {
        process.stderr.write(`\n  PATCH fejl (${update.id}): ${err.message.slice(0, 60)}\n`)
        errors++
      }
      await sleep(25)
    }

    offset += rows.length
    process.stdout.write(`\r  ${done} gemt | ${errors} fejl | offset ${offset}`)

    await sleep(200)
  }

  console.log(`\n  ✅ ${game}: ${done} artwork phash gemt, ${errors} fejl`)
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
