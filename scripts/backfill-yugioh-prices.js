/**
 * Backfill card_prices for YuGiOh via YGOProDeck API (gratis, ingen API-nøgle).
 * Matcher på card_sets[].set_code ↔ card_catalog.number (f.eks. "MP21-EN141").
 *
 * Kør: node scripts/backfill-yugioh-prices.js
 */
import 'dotenv/config'
import { dbSelect, dbUpsert } from '../server/middleware/db.js'

const YGOPRO = 'https://db.ygoprodeck.com/api/v7/cardinfo.php'
const HEADERS = { 'User-Agent': 'GradeDex/1.0 (gradedex.app)' }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function buildSetCodePriceMap() {
  console.log('  Henter alle kort fra YGOProDeck API...')
  const r = await fetch(YGOPRO, { headers: HEADERS })
  if (!r.ok) throw new Error(`YGOProDeck API fejl: ${r.status}`)
  const { data } = await r.json()
  console.log(`  ${data.length} distinkte YuGiOh kort hentet`)

  const map = new Map()
  let withPrice = 0

  for (const card of data) {
    const price = parseFloat(card.card_prices?.[0]?.cardmarket_price) || null
    if (!price || !card.card_sets?.length) continue
    withPrice++
    for (const s of card.card_sets) {
      if (s.set_code) map.set(s.set_code.toUpperCase(), price)
    }
  }

  console.log(`  ${withPrice} kort med Cardmarket-pris → ${map.size} sæt-koder mappes`)
  return map
}

async function run() {
  console.log('\n💰 YuGiOh pris-backfill via YGOProDeck\n')

  const priceMap = await buildSetCodePriceMap()

  let offset = 0, matched = 0, unmatched = 0, totalUpserted = 0

  while (true) {
    const rows = await dbSelect(
      'card_catalog',
      `game=eq.yugioh&number=not.is.null&select=id,number&limit=1000&offset=${offset}`
    )
    if (!rows.length) break

    const priceRows = []
    for (const row of rows) {
      if (!row.number) { unmatched++; continue }
      const price = priceMap.get(row.number.toUpperCase())
      if (price) {
        matched++
        priceRows.push({
          catalog_id:  row.id,
          finish:      'Normal',
          price_sell:  price,
          source:      'cardmarket',
          fetched_at:  new Date().toISOString(),
        })
      } else {
        unmatched++
      }
    }

    if (priceRows.length) {
      await dbUpsert('card_prices', priceRows, 'catalog_id,finish')
      totalUpserted += priceRows.length
    }

    offset += rows.length
    process.stdout.write(`\r  ${offset} behandlet | ${matched} match | ${totalUpserted} upserted`)

    await sleep(50)
    if (rows.length < 1000) break
  }

  console.log(`\n\n✅ Færdig!`)
  console.log(`   Matchet:    ${matched}`)
  console.log(`   Ikke match: ${unmatched}`)
  console.log(`   Upserted:   ${totalUpserted}`)
}

run().catch(err => { console.error(err); process.exit(1) })
