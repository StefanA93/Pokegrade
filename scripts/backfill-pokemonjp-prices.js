/**
 * Backfill card_prices for Pokemon Japan via tcgapi.dev (TCGPlayer USD).
 * Matcher direkte på ID: pokemonjp-{tcgapi_id}
 *
 * Kræver: TCGAPI_KEY i .env
 * Kør: node scripts/backfill-pokemonjp-prices.js
 */
import 'dotenv/config'
import { dbSelect, dbUpsert } from '../server/middleware/db.js'

const BASE    = 'https://api.tcgapi.dev/v1'
const HEADERS = { 'X-Api-Key': process.env.TCGAPI_KEY, 'User-Agent': 'GradeDex/1.0 (gradedex.app)' }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function fetchAllSets() {
  const all = []
  let page = 1
  while (true) {
    const r = await fetch(`${BASE}/games/pokemon-japan/sets?limit=100&page=${page}`, { headers: HEADERS })
    if (!r.ok) throw new Error(`HTTP ${r.status} ved sæt-hentning`)
    const d = await r.json()
    const batch = d.data || []
    all.push(...batch)
    if (!d.meta?.has_more || batch.length < 100) break
    page++
    await sleep(150)
  }
  return all
}

async function fetchSetCards(setId) {
  const cards = []
  let page = 1
  while (true) {
    const r = await fetch(`${BASE}/sets/${setId}/cards?limit=100&page=${page}`, { headers: HEADERS })
    if (!r.ok) break
    const d = await r.json()
    const batch = d.data || []
    if (!batch.length) break
    cards.push(...batch)
    if (!d.meta?.has_more && batch.length < 100) break
    page++
    await sleep(100)
  }
  return cards
}

async function run() {
  if (!process.env.TCGAPI_KEY) {
    console.error('❌  TCGAPI_KEY mangler i .env')
    process.exit(1)
  }

  console.log('\n💰 Pokemon Japan pris-backfill via tcgapi.dev (TCGPlayer USD)\n')

  // Byg lookup: pokemonjp-{id} → catalog_id
  process.stdout.write('  Indlæser katalog ')
  const catalogMap = new Map()
  let offset = 0
  while (true) {
    const rows = await dbSelect('card_catalog', `game=eq.pokemonjp&select=id&limit=1000&offset=${offset}`)
    if (!rows.length) break
    for (const r of rows) {
      const tcgId = r.id.replace('pokemonjp-', '')
      catalogMap.set(tcgId, r.id)
    }
    offset += rows.length
    process.stdout.write('.')
    if (rows.length < 1000) break
  }
  console.log(` ${catalogMap.size} kort i katalog\n`)

  const sets = await fetchAllSets()
  console.log(`  ${sets.length} sæt fundet\n`)

  let totalUpserted = 0, totalSkipped = 0, totalNoPrice = 0

  for (let i = 0; i < sets.length; i++) {
    const set = sets[i]
    const pct = (((i + 1) / sets.length) * 100).toFixed(0)
    process.stdout.write(`\r  [${i + 1}/${sets.length}] (${pct}%) ${set.name.padEnd(45)} ↑${totalUpserted}`)

    const cards = await fetchSetCards(set.id)
    const rows = []
    const seen = new Set()

    for (const card of cards) {
      if (!card.id || !card.market_price) { totalNoPrice++; continue }

      const tcgId    = String(card.id)
      const catalogId = catalogMap.get(tcgId)
      if (!catalogId) { totalSkipped++; continue }

      const finish = card.foil_only ? 'Foil' : 'Normal'
      const key    = `${catalogId}:${finish}`
      if (seen.has(key)) continue
      seen.add(key)

      rows.push({
        catalog_id:  catalogId,
        finish,
        source:      'tcgplayer',
        price_sell:  parseFloat(card.market_price)  || null,
        price_low:   parseFloat(card.low_price)     || null,
        price_avg7:  parseFloat(card.median_price)  || null,
        price_avg30: null,
      })
    }

    if (rows.length) {
      await dbUpsert('card_prices', rows, 'catalog_id,finish')
      totalUpserted += rows.length
    }
  }

  console.log('\n')
  console.log('══════════════════════════════════════════')
  console.log('✅ Upserted:     ', totalUpserted)
  console.log('⏩ Ingen pris:   ', totalNoPrice)
  console.log('❌ Ikke-matchet: ', totalSkipped)
  console.log(`Match rate:       ${((totalUpserted / (totalUpserted + totalSkipped)) * 100).toFixed(1)}%`)
}

run().catch(e => { console.error(e); process.exit(1) })
