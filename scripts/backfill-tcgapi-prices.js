import 'dotenv/config'
import { getProvider } from '../packages/providers/index.js'
import { dbSelect, dbUpsert } from '../server/middleware/db.js'

const GAME        = process.argv[2]
const VALID_GAMES = ['yugioh', 'dragonball', 'lorcana', 'onepiece', 'pokemonjp']

if (!GAME || !VALID_GAMES.includes(GAME)) {
  console.error('Brug: node scripts/backfill-tcgapi-prices.js <game>')
  console.error('Spil: ' + VALID_GAMES.join(' | '))
  process.exit(1)
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function buildFallbackId(game, setCode, number) {
  const safeNum = String(number || 'x').replace(/[^a-zA-Z0-9]/g, '')
  return `${game}-${setCode}-${safeNum}`.toLowerCase()
}

async function run() {
  const provider = getProvider(GAME)

  const setRows = await dbSelect('sets', `game_id=eq.${GAME}&select=code,name&order=release_date.desc&limit=500`)
  const sets    = setRows.filter(r => r.code)
  console.log(`\n💰 ${GAME} — ${sets.length} sæt fundet\n`)

  let totalPrices = 0
  let skippedSets = 0

  for (let i = 0; i < sets.length; i++) {
    const { code, name } = sets[i]
    const pct = (((i + 1) / sets.length) * 100).toFixed(0)
    process.stdout.write(`\r  [${i + 1}/${sets.length}] (${pct}%) ${String(name || code).slice(0, 30).padEnd(32)} priser: ${totalPrices}`)

    let cards
    try {
      cards = await provider.fetchCardsForSet(code)
    } catch {
      skippedSets++
      await sleep(1000)
      continue
    }

    const priceRows = []
    for (const c of cards) {
      if (!c.prices) continue
      const catalogId = c.providerIds?.tcgapi
        ? `${GAME}-${c.providerIds.tcgapi}`
        : buildFallbackId(GAME, code, c.number)

      for (const [finish, p] of Object.entries(c.prices)) {
        if (!p?.sell) continue
        priceRows.push({
          catalog_id: catalogId,
          finish,
          price_sell: p.sell,
          cm_url:     p.cmUrl || null,
          source:     'tcgplayer',
          fetched_at: new Date().toISOString(),
        })
      }
    }

    if (priceRows.length) {
      try {
        await dbUpsert('card_prices', priceRows, 'catalog_id,finish')
        totalPrices += priceRows.length
      } catch (err) {
        process.stdout.write(`\n  ❌ Upsert fejl (${name || code}): ${err.message.slice(0, 80)}\n`)
      }
    }

    await sleep(300)
  }

  console.log(`\n\n✅ Færdig!`)
  console.log(`   Prisrækker upserted: ${totalPrices}`)
  console.log(`   Sæt sprunget over:   ${skippedSets}`)
}

run().catch(err => { console.error(err); process.exit(1) })
