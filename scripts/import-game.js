/**
 * Direkte import af kortdata for ét spil — ingen Redis/BullMQ nødvendig.
 * Henter sæt → kort → upsert til card_catalog.
 * Kør derefter backfill-phash-only.js <game> for phash.
 *
 * Brug:
 *   node scripts/import-game.js yugioh
 *   node scripts/import-game.js onepiece
 *   node scripts/import-game.js lorcana
 *   node scripts/import-game.js dragonball
 */
import 'dotenv/config'
import { getProvider } from '../packages/providers/index.js'
import { dbUpsert, dbCount } from '../server/middleware/db.js'

const GAME           = process.argv[2]
const DELAY_SET_MS   = 400
const DELAY_ERROR_MS = 5000
const MAX_SET_ERRORS = 3

if (!GAME) {
  console.error('Brug: node scripts/import-game.js <game>')
  console.error('Spil: yugioh | onepiece | lorcana | dragonball | mtg | pokemon | pokemonjp')
  process.exit(1)
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function buildCatalogId(gameId, setId, number) {
  const safeNum = String(number || 'x').replace(/[^a-zA-Z0-9]/g, '')
  return `${gameId}-${setId}-${safeNum}`.toLowerCase()
}

async function run() {
  const provider = getProvider(GAME)

  console.log(`\n📦 Henter sæt for ${GAME}…`)
  let sets
  try {
    sets = await provider.fetchAllSets()
  } catch (err) {
    console.error('Kunne ikke hente sæt:', err.message)
    process.exit(1)
  }
  console.log(`   Fandt ${sets.length} sæt\n`)

  let totalCards  = 0
  let totalErrors = 0
  let skipped     = 0

  for (let i = 0; i < sets.length; i++) {
    const s    = sets[i]
    const pct  = (((i + 1) / sets.length) * 100).toFixed(0)
    process.stdout.write(`\r  [${i + 1}/${sets.length}] (${pct}%) ${String(s.name || s.code).slice(0, 30).padEnd(32)} kort: ${totalCards} | fejl: ${totalErrors}`)

    let cards = []
    let attempts = 0
    while (attempts < MAX_SET_ERRORS) {
      try {
        cards = await provider.fetchCardsForSet(s.externalId || s.code)
        break
      } catch (err) {
        attempts++
        if (attempts >= MAX_SET_ERRORS) { skipped++; break }
        await sleep(DELAY_ERROR_MS * attempts)
      }
    }

    if (!cards.length) {
      await sleep(DELAY_SET_MS)
      continue
    }

    const catalogRows = cards.map(c => ({
      id:           buildCatalogId(GAME, s.externalId || s.code, c.number),
      game:         GAME,
      name:         c.name,
      number:       c.number || null,
      set_id:       s.externalId || s.code,
      set_name:     c.setName || s.name || null,
      rarity:       c.rarity || null,
      finish_types: c.finishTypes || ['Normal'],
      image_url:    c.imageUrl || null,
      updated_at:   new Date().toISOString(),
    }))

    try {
      await dbUpsert('card_catalog', catalogRows, 'id')
      totalCards += catalogRows.length
    } catch (err) {
      totalErrors += catalogRows.length
    }

    await sleep(DELAY_SET_MS)
  }

  console.log(`\n\n✅ Færdig!`)
  console.log(`   Kort importeret: ${totalCards}`)
  console.log(`   Fejl:            ${totalErrors}`)
  console.log(`   Sæt sprunget over: ${skipped}`)

  const dbTotal = await dbCount('card_catalog', `game=eq.${GAME}`)
  console.log(`   Total i database: ${dbTotal}`)
  console.log(`\n➡  Kør nu: node scripts/backfill-phash-only.js ${GAME}`)
}

run().catch(err => { console.error(err); process.exit(1) })
